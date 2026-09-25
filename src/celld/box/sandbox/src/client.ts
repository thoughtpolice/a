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
 * import { getSandbox } from "@celld/box/sandbox";
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

import { opaqueIdentity } from "@celld/core/bounds";
import { randomToken, strictRecord } from "./core.ts";
import { SandboxError } from "./errors.ts";
import { withWorkspaceLease, type WorkspaceLeaseOptions } from "./lease.ts";
import {
  ExposePortOptions as ExposeSchema,
  parse,
  Port,
  RotatePortOptions as RotateSchema,
} from "./schemas.ts";
import { parseSSEStream } from "./sse.ts";
import type {
  ExecOptions,
  ExecResult,
  ExistsResult,
  ExposedPort,
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
  SandboxEvent,
  SearchFilesOptions,
  SearchResult,
  SessionInfo,
  SessionOptions,
  SessionUpdate,
  StreamExecOptions,
  StreamRequest,
  WaitForLogOptions,
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
  /**
   * Build `http:` preview URLs, which carry the port's token in cleartext,
   * for a local `celld dev` only: the host name must be `localhost` or
   * end in `.localhost`, else it is `SandboxError("invalid")`. Without it, preview
   * URLs are `https:`. (The old `protocol: "http"` is refused.)
   */
  readonly httpForDevelopment?: boolean;
  /** Appended to the host (1-65535), such as `:9876` for a local `celld dev`. */
  readonly port?: number;
}

function isLocalhost(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return name === "localhost" || name.endsWith(".localhost");
}

function checkedHostname(value: unknown): string {
  if (
    typeof value !== "string" || value.length > 189 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) ||
    value.split(".").some((label) =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
    )
  ) {
    throw new SandboxError(
      "invalid",
      "preview hostname must be an ASCII DNS name without port, path, or trailing dot",
    );
  }
  return value.toLowerCase();
}

/**
 * `options` checked and copied: `invalid` for any unknown option,
 * `httpForDevelopment` off a `localhost` name, or a port
 * outside 1-65535.
 */
function checkClientOptions(
  options: SandboxClientOptions,
): Readonly<SandboxClientOptions> {
  strictRecord(
    options,
    ["hostname", "port", "httpForDevelopment"],
    "SandboxClientOptions",
  );
  const hostname = options.hostname === undefined
    ? undefined
    : checkedHostname(options.hostname);
  const { port } = options;
  if (
    options.httpForDevelopment !== undefined &&
    typeof options.httpForDevelopment !== "boolean"
  ) throw new SandboxError("invalid", "httpForDevelopment must be a boolean");
  const http = options.httpForDevelopment === true;
  if (http && hostname !== undefined && !isLocalhost(hostname)) {
    throw new SandboxError(
      "invalid",
      `SandboxClientOptions: \`httpForDevelopment\` needs a localhost hostname, not ${hostname}`,
    );
  }
  if (
    port !== undefined &&
    !(Number.isInteger(port) && port >= 1 && port <= 65535)
  ) {
    throw new SandboxError("invalid", `SandboxClientOptions: bad port ${port}`);
  }
  return Object.freeze({
    ...(hostname === undefined ? {} : { hostname }),
    ...(http ? { httpForDevelopment: true } : {}),
    ...(port === undefined ? {} : { port }),
  });
}

// A DNS label has at most 63 characters: 5 for the port, 26 for the
// token and two dashes leave 30 for the id.
const PREVIEW_ID = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const PREVIEW_LABEL =
  /^(\d{1,5})-([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)-([a-z2-7]{26})$/;

/**
 * The preview URL of an exposed port: `https://<port>-<id>-<token>.<hostname>`
 * (`http:` only with `httpForDevelopment` and a `localhost` name). The
 * sandbox id must be a DNS label of lowercase letters, digits and `-`, at
 * most 30 characters, so the whole label stays within DNS's 63. Bad
 * options throw `SandboxError("invalid")`.
 */
export function previewUrl(
  id: string,
  exposed: Pick<ExposedPort, "port" | "token">,
  options: SandboxClientOptions & { readonly hostname: string },
): string {
  if (typeof id !== "string" || !PREVIEW_ID.test(id)) {
    throw new SandboxError(
      "invalid",
      "preview URLs need a sandbox id of at most 30 lowercase letters, digits and -",
    );
  }
  strictRecord(exposed, [
    "port",
    "token",
    "name",
    "createdAt",
    "rotatedAt",
    "expiresAt",
    "url",
  ], "preview port");
  if (
    !Number.isInteger(exposed.port) || exposed.port < 1 ||
    exposed.port > 65535 || typeof exposed.token !== "string" ||
    !/^[a-z2-7]{26}$/.test(exposed.token)
  ) throw new SandboxError("invalid", "invalid exposed port/token");
  const checked = checkClientOptions(options);
  if (checked.hostname === undefined) {
    throw new SandboxError("invalid", "previewUrl needs a hostname");
  }
  const port = checked.port === undefined ? "" : `:${checked.port}`;
  const scheme = checked.httpForDevelopment === true ? "http" : "https";
  const url = new URL(
    `${scheme}://${exposed.port}-${id}-${exposed.token}.${checked.hostname}${port}`,
  );
  if (
    url.username || url.password || url.pathname !== "/" || url.search ||
    url.hash || parsePreviewHost(url.host, checked.hostname)?.id !== id ||
    (scheme === "http" && !isLocalhost(url.hostname))
  ) throw new SandboxError("invalid", "preview origin does not round-trip");
  return url.origin;
}

/** The port, sandbox id and token of a preview host name, or null. */
export function parsePreviewHost(
  host: string,
  hostname?: string,
): { port: number; id: string; token: string } | null {
  if (
    typeof host !== "string" || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)
  ) return null;
  const pieces = host.split(":");
  if (
    pieces[1] !== undefined &&
    (!/^[1-9][0-9]*$/.test(pieces[1]) || Number(pieces[1]) > 65535)
  ) return null;
  const name = pieces[0].toLowerCase();
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
  options: SandboxClientOptions & { readonly hostname: string },
): Promise<Response | null> {
  return await proxyRequest(request, namespace, checkClientOptions(options));
}

/** Prepare the preview policy once for a Worker's request hot path. Content must be trusted. */
export function createPreviewProxy<T extends SandboxApi>(
  namespace: DurableObjectNamespace<T>,
  options: SandboxClientOptions & { readonly hostname: string },
): (request: Request) => Promise<Response | null> {
  const checked = checkClientOptions(options);
  if (checked.hostname === undefined) {
    throw new SandboxError(
      "invalid",
      "preview proxy requires an expected hostname",
    );
  }
  return (request) => proxyRequest(request, namespace, checked);
}

async function proxyRequest<T extends SandboxApi>(
  request: Request,
  namespace: DurableObjectNamespace<T>,
  checked: Readonly<SandboxClientOptions>,
): Promise<Response | null> {
  if (checked.hostname === undefined) {
    throw new SandboxError(
      "invalid",
      "preview proxy requires an expected hostname",
    );
  }
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host !== null && host.toLowerCase() !== url.host.toLowerCase()) {
    return new Response("invalid authority", { status: 400 });
  }
  const target = parsePreviewHost(url.host, checked.hostname);
  if (target === null) return null;
  const protocol = checked.httpForDevelopment === true ? "http:" : "https:";
  const defaultPort = protocol === "https:" ? 443 : 80;
  if (
    url.protocol !== protocol ||
    Number(url.port || defaultPort) !== (checked.port ?? defaultPort) ||
    url.username || url.password || url.hash
  ) return new Response("invalid preview origin", { status: 400 });
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      name === "host" || name === "forwarded" || name === "referer" ||
      name === "origin" || name.startsWith("x-forwarded-") ||
      name === "x-original-host"
    ) headers.delete(name);
  }
  headers.set(PREVIEW_HEADER, `${target.port}:${target.token}`);
  const stub = namespace.getByName(target.id);
  url.host = "sandbox.internal";
  url.protocol = "http:";
  return hardenPreviewResponse(
    await stub.fetch(new Request(url, new Request(request, { headers }))),
  );
}

/** Trusted-active-content previews only: browsers can read their bearer hostname. */
export function hardenPreviewResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", "no-referrer");
  headers.set("cache-control", "private, no-store");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.delete("set-cookie");
  headers.set(
    "strict-transport-security",
    "max-age=31536000; includeSubDomains",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Stable DNS-safe name from a full canonical principal key; never pass a raw subject/email. */
export async function deriveSandboxId(
  secret: Uint8Array | CryptoKey,
  namespace: string,
  identity: string,
): Promise<string> {
  if (
    typeof namespace !== "string" || !namespace.trim() || namespace.length > 242
  ) {
    throw new SandboxError(
      "invalid",
      "sandbox identity requires an application purpose of 1-242 characters",
    );
  }
  return (await opaqueIdentity(secret, `celld/sandbox/${namespace}`, identity))
    .slice(0, 26);
}

type Stub = DurableObjectStub<SandboxApi>;

/** Options of `execStream`: `stdin` may also be a stream, sent as the body. */
export type ClientStreamOptions =
  & Omit<StreamExecOptions, "stdin">
  & {
    readonly stdin?: string | Uint8Array | ReadableStream<Uint8Array>;
    readonly signal?: AbortSignal;
  };

// `stream`, cancelled (which kills its command) when `signal` aborts.
function abortable(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  if (signal === undefined) return stream;
  if (signal.aborted) {
    stream.cancel(signal.reason).catch(() => {});
    return stream;
  }
  return stream.pipeThrough(new TransformStream(), { signal });
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw SandboxError.wrap(error);
  }
}

/** Restricted file lease capability. Arbitrary commands require the trusted low-level lease API. */
export interface WorkspaceClient {
  readFile: SandboxClient["readFile"];
  listFiles: SandboxClient["listFiles"];
  stat: SandboxClient["stat"];
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: Omit<WriteFileOptions, "lease">,
  ): Promise<void>;
  writeFileStream(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array | string,
    options?: Omit<WriteFileOptions, "lease" | "encoding"> & {
      readonly signal?: AbortSignal;
    },
  ): Promise<{ path: string; size: number }>;
  mkdir(path: string, options?: Omit<RecursiveOptions, "lease">): Promise<void>;
  remove(
    path: string,
    options?: Omit<RecursiveOptions, "lease">,
  ): Promise<void>;
  deleteFile(path: string): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
  gitCheckout(
    url: string,
    options?: Omit<GitCheckoutOptions, "lease" | "unsafeSymlinks">,
  ): Promise<ExecResult>;
}

/** See the module documentation. Every method maps to the object's RPC method. */
export class SandboxClient {
  readonly #stub: Stub;
  readonly #options: Readonly<SandboxClientOptions>;

  /** Throws `SandboxError("invalid")` for bad options; see {@link SandboxClientOptions}. */
  constructor(
    stub: Stub,
    readonly id: string,
    options: SandboxClientOptions = {},
  ) {
    this.#options = checkClientOptions(options);
    if (this.#options.hostname !== undefined && !PREVIEW_ID.test(id)) {
      throw new SandboxError(
        "invalid",
        "preview clients require a DNS-safe id of at most 30 characters",
      );
    }
    this.#stub = stub;
  }

  /**
   * The raw Durable Object stub. **Unsafe**: it bypasses this client, whose
   * methods are the capability a holder of a `SandboxClient` has. The stub
   * also offers `fetch` (stream tickets, preview forwarding) and every RPC
   * method of the class, including subclass methods and `fetchPort` to any
   * container port, with no error mapping. Hand a `SandboxClient` (or a
   * narrower wrapper of your own) to code that should not have all of
   * that, never this.
   */
  get unsafeStub(): Stub {
    return this.#stub;
  }

  /** A file capability restricted to this lease; writes carry its token. It cannot execute code or change shared settings. */
  withWorkspaceLease<T>(
    work: (workspace: WorkspaceClient, signal: AbortSignal) => Promise<T>,
    options: WorkspaceLeaseOptions & { readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    strictRecord(
      options,
      ["signal", "ttlMs", "maxHoldMs"],
      "workspace lease options",
    );
    const { signal, ...leaseOptions } = options;
    return withWorkspaceLease(this, signal, async (fence, lease) => {
      let closed = false;
      const access = () => {
        if (closed) {
          throw new SandboxError(
            "lease_lost",
            "workspace capability has expired",
          );
        }
        fence.throwIfAborted();
      };
      const boundSignal = (other?: AbortSignal) =>
        other === undefined ? fence : AbortSignal.any([fence, other]);
      const workspace = Object.freeze<WorkspaceClient>({
        readFile: (path, opts) => {
          access();
          return this.readFile(path, opts);
        },
        listFiles: (path, opts) => {
          access();
          return this.listFiles(path, opts);
        },
        stat: (path, opts) => {
          access();
          return this.stat(path, opts);
        },
        writeFile: (path, content, opts) => {
          access();
          return this.writeFile(path, content, { ...opts, lease });
        },
        writeFileStream: (path, body, opts) => {
          access();
          return this.writeFileStream(path, body, {
            ...opts,
            lease,
            signal: boundSignal(opts?.signal),
          });
        },
        mkdir: (path, opts) => {
          access();
          return this.mkdir(path, { ...opts, lease });
        },
        remove: (path, opts) => {
          access();
          return this.remove(path, { ...opts, lease });
        },
        deleteFile: (path) => {
          access();
          return this.deleteFile(path, { lease });
        },
        renameFile: (from, to) => {
          access();
          return this.renameFile(from, to, { lease });
        },
        gitCheckout: (url, opts) => {
          access();
          return this.gitCheckout(url, {
            ...opts,
            unsafeSymlinks: false,
            lease,
            signal: boundSignal(opts?.signal),
          });
        },
      });
      try {
        return await work(workspace, fence);
      } finally {
        /* Retained facades are invalid after this callback returns. */ closed =
          true;
      }
    }, leaseOptions);
  }

  /** Parses a stream from `execStream` or `streamProcessLogs` into events. */
  events(stream: ReadableStream<Uint8Array>): AsyncGenerator<SandboxEvent> {
    return parseSSEStream<SandboxEvent>(stream);
  }

  /**
   * Runs `argv`. A `signal` becomes a cancel token: aborting it calls the
   * object's `cancel`, which kills the command, and the call rejects with
   * the signal's reason.
   */
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult> {
    return this.#cancellable(options, (plain) => this.#stub.exec(argv, plain));
  }

  execShell(script: string, options?: ExecOptions): Promise<ExecResult> {
    return this.#cancellable(
      options,
      (plain) => this.#stub.execShell(script, plain),
    );
  }

  async #cancellable<
    O extends { readonly signal?: AbortSignal; readonly cancelToken?: string },
    T,
  >(
    options: O | undefined,
    run: (options: O | undefined) => Promise<T>,
  ): Promise<T> {
    const signal = options?.signal;
    if (signal === undefined) return await call(() => run(options));
    signal.throwIfAborted();
    const { signal: _, ...rest } = options!;
    const token = randomToken(26);
    const onAbort = () => {
      this.#stub.cancel(token).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await call(() => run({ ...rest, cancelToken: token } as O));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Cancels an exec started with `cancelToken: token`. */
  cancel(token: string): Promise<boolean> {
    return call(() => this.#stub.cancel(token));
  }

  async #open(
    request: StreamRequest,
    body?: BodyInit,
    method = "GET",
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const ticket = await call(() => this.#stub.openStream(request));
    if (signal?.aborted) {
      await this.#stub.cancelStream(ticket);
      signal.throwIfAborted();
    }
    const onAbort = () => {
      this.#stub.cancelStream(ticket).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await this.#stub.fetch(
        new Request(`http://sandbox${STREAM_PATH}${ticket}`, {
          method,
          signal,
          ...(body === undefined ? {} : { body }),
        }),
      );
    } catch (error) {
      await this.#stub.cancelStream(ticket).catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) {
      await response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
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
    options?: ClientStreamOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return await this.#openExec({ kind: "exec", argv }, options);
  }

  async execShellStream(
    script: string,
    options?: ClientStreamOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return await this.#openExec({ kind: "shell", script }, options);
  }

  // A stream `stdin` travels as the body of the redeeming request, so it is
  // never stored in the ticket (which is capped).
  async #openExec(
    request:
      | { kind: "exec"; argv: string[] }
      | { kind: "shell"; script: string },
    options: ClientStreamOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const { signal, stdin, ...rest } = options;
    const streamed = stdin instanceof ReadableStream;
    const response = await this.#open(
      {
        ...request,
        options: streamed || stdin === undefined ? rest : { ...rest, stdin },
        ...(streamed ? { bodyStdin: true } : {}),
      } as StreamRequest,
      streamed ? stdin : undefined,
      streamed ? "POST" : "GET",
      signal,
    );
    return abortable(response.body!, signal);
  }

  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult> {
    return call(() => this.#stub.readFile(path, options));
  }

  /** A file's bytes as a stream, for files past `readFile`'s limit. */
  async readFileStream(
    path: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    strictRecord(options, ["signal"], "readFileStream options");
    return abortable(
      (await this.#open(
        { kind: "read", path },
        undefined,
        "GET",
        options.signal,
      )).body!,
      options.signal,
    );
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
    options: Omit<WriteFileOptions, "encoding"> & {
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<{ path: string; size: number }> {
    const { signal, ...plain } = options;
    const response = await this.#open(
      { kind: "write", path, options: plain },
      body as BodyInit,
      "PUT",
      signal,
    );
    return await response.json();
  }

  mkdir(path: string, options?: RecursiveOptions): Promise<void> {
    return call(() => this.#stub.mkdir(path, options));
  }

  deleteFile(path: string, options?: LeaseOption): Promise<void> {
    return call(() => this.#stub.deleteFile(path, options));
  }

  remove(path: string, options?: RecursiveOptions): Promise<void> {
    return call(() => this.#stub.remove(path, options));
  }

  renameFile(from: string, to: string, options?: LeaseOption): Promise<void> {
    return call(() => this.#stub.renameFile(from, to, options));
  }

  moveFile(from: string, to: string, options?: LeaseOption): Promise<void> {
    return call(() => this.#stub.moveFile(from, to, options));
  }

  exists(path: string, options?: NoFollowOptions): Promise<ExistsResult> {
    return call(() => this.#stub.exists(path, options));
  }

  stat(path: string, options?: NoFollowOptions): Promise<FileStat> {
    return call(() => this.#stub.stat(path, options));
  }

  listFiles(
    path?: string,
    options?: ListFilesOptions,
  ): Promise<ListFilesResult> {
    return call(() => this.#stub.listFiles(path, options));
  }

  /** Clones a repository; a `signal` cancels the clone as it does `exec`. */
  gitCheckout(url: string, options?: GitCheckoutOptions): Promise<ExecResult> {
    return this.#cancellable(
      options,
      (plain) => this.#stub.gitCheckout(url, plain),
    );
  }

  /** Searches the workspace's files; a `signal` cancels it as it does `exec`. */
  searchFiles(
    pattern: string,
    options?: SearchFilesOptions,
  ): Promise<SearchResult> {
    return this.#cancellable(
      options,
      (plain) => this.#stub.searchFiles(pattern, plain),
    );
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

  /** One page of processes, oldest first; pass `cursor` for the next. */
  listProcesses(options?: ListProcessesOptions): Promise<ProcessList> {
    return call(() => this.#stub.listProcesses(options));
  }

  deleteProcess(id: string): Promise<void> {
    return call(() => this.#stub.deleteProcess(id));
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
    options?: WaitForLogOptions,
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
      url: previewUrl(this.id, { port: exposed.port, token: exposed.token }, {
        ...this.#options,
        hostname: host,
      }),
    };
  }

  /** Exposes a port; with a host name (here or in the client options) the result has its URL. */
  async exposePort(
    port: number,
    options: { name?: string; ttlMs?: number; hostname?: string } = {},
  ): Promise<ExposedPort> {
    strictRecord(options, ["name", "ttlMs", "hostname"], "exposePort options");
    const { hostname, ...rest } = options;
    parse(Port, port, "port");
    parse(ExposeSchema, rest, "exposePort options");
    if (hostname !== undefined) checkedHostname(hostname);
    const host = hostname ?? this.#options.hostname;
    if (host !== undefined) {
      previewUrl(this.id, { port, token: "a".repeat(26) }, {
        ...this.#options,
        hostname: host,
      });
    }
    const exposed = await call(() => this.#stub.exposePort(port, rest));
    return this.#withUrl(exposed, hostname);
  }

  /** Replaces a port's token (the old one stops working); with a URL when the host name is known. */
  async rotatePort(
    port: number,
    options: { expectedToken: string; ttlMs?: number; hostname?: string },
  ): Promise<ExposedPort> {
    strictRecord(
      options,
      ["expectedToken", "ttlMs", "hostname"],
      "rotatePort options",
    );
    const { hostname, ...rest } = options;
    parse(Port, port, "port");
    parse(RotateSchema, rest, "rotatePort options");
    if (hostname !== undefined) checkedHostname(hostname);
    const host = hostname ?? this.#options.hostname;
    if (host !== undefined) {
      previewUrl(this.id, { port, token: "a".repeat(26) }, {
        ...this.#options,
        hostname: host,
      });
    }
    const exposed = await call(() => this.#stub.rotatePort(port, rest));
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

  updateSession(id: string, patch?: SessionUpdate): Promise<SessionInfo> {
    return call(() => this.#stub.updateSession(id, patch));
  }

  deleteSession(id: string): Promise<void> {
    return call(() => this.#stub.deleteSession(id));
  }

  listSessions(): Promise<SessionInfo[]> {
    return call(() => this.#stub.listSessions());
  }

  /** The lease on `name`, or null while another holder has it. */
  acquireLease(name: string, options?: LeaseOptions): Promise<Lease | null> {
    return call(() => this.#stub.acquireLease(name, options));
  }

  renewLease(
    name: string,
    token: string,
    options?: LeaseOptions,
  ): Promise<Lease | null> {
    return call(() => this.#stub.renewLease(name, token, options));
  }

  releaseLease(name: string, token: string): Promise<boolean> {
    return call(() => this.#stub.releaseLease(name, token));
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

  /**
   * Ends the sandbox: its stored state (environment, sessions, ports and
   * their tokens, tickets, process records) is cleared and its container
   * destroyed.
   */
  destroy(): Promise<void> {
    return call(() => this.#stub.destroy());
  }

  /** Destroys the container only; the stored state and tokens stay. */
  destroyContainer(): Promise<void> {
    return call(() => this.#stub.destroyContainer());
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
    options: ClientStreamOptions = {},
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
  const checked = checkClientOptions(options);
  if (checked.hostname !== undefined && !PREVIEW_ID.test(id)) {
    throw new SandboxError(
      "invalid",
      "preview clients require a DNS-safe id of at most 30 characters",
    );
  }
  return new SandboxClient(
    namespace.getByName(id) as unknown as Stub,
    id,
    checked,
  );
}

/** High-level per-principal factory; the canonical identity must include issuer/tenant/client/subject. */
export async function getPrincipalSandbox<T extends SandboxApi>(
  namespace: DurableObjectNamespace<T>,
  secret: Uint8Array | CryptoKey,
  purpose: string,
  canonicalIdentity: string,
  options: SandboxClientOptions = {},
): Promise<SandboxClient> {
  const checked = checkClientOptions(options);
  return getSandbox(
    namespace,
    await deriveSandboxId(secret, purpose, canonicalIdentity),
    checked,
  );
}
