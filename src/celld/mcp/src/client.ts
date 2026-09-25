// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `McpClient`: typed MCP 2026-07-28 calls over any {@link Transport}.
 *
 * Every request carries the protocol version, the client's capabilities and
 * its `clientInfo` in `_meta`, so there is no connect step: construct the
 * client and call. `discover()` picks a version up front; otherwise an
 * `UnsupportedProtocolVersionError` on any call switches to a mutually
 * supported version and retries once.
 *
 * `callTool`, `getPrompt` and `readResource` run the multi round-trip loop:
 * when the server answers `input_required`, the client asks its
 * {@link InputHandlers} (elicitation, and the deprecated sampling and
 * roots), then retries with `inputResponses` and the server's
 * `requestState`, echoed exactly, under a new request id.
 *
 * A request is sent again after a failure only when repeating it cannot
 * repeat an effect: reads (see {@link READ_ONLY_METHODS}), a `tools/call`
 * of a tool advertising `idempotentHint`, or a `tools/call` carrying an
 * idempotency key for a server that advertises durable deduplication
 * (`retry` and `CallOptions.idempotencyKey`).
 *
 * @module
 */

import { nonNegativeMs, safeInt, strictRecord } from "@celld/core/bounds";
import { bag, snapshotOptions, table } from "./snapshot.ts";
import { type HttpRetryPolicy, mayRetry, type RetryFailure } from "@celld/http";
import { CACHEABLE_METHODS, cacheKey, type ResultCache } from "./cache.ts";
import {
  attempt,
  McpError,
  mcpErrorFromRpc,
  type McpOutcome,
} from "./errors.ts";
import {
  argumentAt,
  encodeHeaderValue,
  HEADER,
  NAME_SOURCE,
  type ParamHeader,
  paramHeaders,
  paramHeaderValue,
} from "./headers.ts";
import {
  IDEMPOTENCY_CAPABILITY,
  IDEMPOTENCY_KEY,
  isIdempotencyKey,
} from "./idempotency.ts";
import { type CompiledSchema, compileSchema } from "./jsonschema.ts";
import { formatIssues, isPlainObject } from "./json.ts";
import { META } from "./meta.ts";
import { isTaskToken, TASK_TOKEN, TASK_TOKENS } from "./ownership.ts";
import {
  httpTransport,
  type HttpTransportOptions,
  STATUS,
} from "./transport.ts";
import type { Transport } from "./transport.ts";
import {
  type DetailedTask,
  isTerminalStatus,
  type Task,
  TASK_AUGMENTABLE,
  TASKS_EXTENSION,
} from "./tasks.ts";
import {
  type CallToolResult,
  type ClientCapabilities,
  type ClientRequestMethod,
  type CompleteRequestParams,
  type CompleteResult,
  type CreateMessageRequestParams,
  type CreateMessageResult,
  type DiscoverResult,
  type ElicitRequestParams,
  type ElicitResult,
  type GetPromptResult,
  HEADER_MISMATCH,
  type Implementation,
  type InputRequests,
  type InputResponses,
  INVALID_REQUEST,
  type JSONRPCNotification,
  type JSONRPCResponse,
  LATEST_PROTOCOL_VERSION,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListRootsResult,
  type ListToolsResult,
  type LoggingLevel,
  type LoggingMessageNotificationParams,
  type ProgressNotificationParams,
  type ReadResourceResult,
  type RequestId,
  type Result,
  type ServerNotification,
  type SubscriptionFilter,
  type Tool,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./types.ts";
import {
  check,
  createTaskResult,
  INPUT_RESPONSE,
  inputRequest,
  inputRequiredResult,
  NOTIFICATION,
  RESULT,
} from "./validate.ts";

/** Answers the server's input requests. */
export interface InputHandlers {
  /**
   * Elicits information from the user. For URL mode, `accept` means the user
   * consented to open the URL; the client never opens it without consent.
   */
  readonly elicitation?: (
    params: ElicitRequestParams,
    context: InputContext,
  ) => ElicitResult | Promise<ElicitResult>;
  /** The elicitation modes the handler supports; default `["form"]`. */
  readonly elicitationModes?: readonly ("form" | "url")[];
  /**
   * Samples an LLM for the server.
   *
   * @deprecated Sampling is deprecated as of 2026-07-28 (SEP-2577).
   */
  readonly sampling?: (
    params: CreateMessageRequestParams,
    context: InputContext,
  ) => CreateMessageResult | Promise<CreateMessageResult>;
  /**
   * Lists the client's roots.
   *
   * @deprecated Roots are deprecated as of 2026-07-28 (SEP-2577).
   */
  readonly roots?: (
    context: InputContext,
  ) => ListRootsResult | Promise<ListRootsResult>;
}

/** What an input handler knows about the request that needs it. */
export interface InputContext {
  /** The server's key for this input request. */
  readonly key: string;
  /** The request that is waiting: `tools/call`, `prompts/get` or `resources/read`. */
  readonly method: string;
  /** The tool or prompt name, or the resource URI. */
  readonly name: string;
  /** The task asking, when the request runs as a task (the tasks extension). */
  readonly taskId?: string;
  readonly signal: AbortSignal;
}

/** How the client follows tasks (the tasks extension). */
export interface ClientTaskOptions {
  /** Poll interval when the server suggests none; default 500 ms. */
  readonly initialPollMs?: number;
  /**
   * The shortest wait between polls, whatever the server suggests (a
   * `pollIntervalMs` of 0 would poll in a loop), 1 ms to 60 s; default
   * 100 ms.
   */
  readonly minPollMs?: number;
  /**
   * The longest wait between polls while nothing changes; default 10 s. A
   * server's larger `pollIntervalMs` still wins, up to five minutes.
   */
  readonly maxPollMs?: number;
  /** Transient `tasks/get` failures tolerated in a row, 0 to 100; default 5. */
  readonly maxPollErrors?: number;
  /**
   * Also open a `subscriptions/listen` stream for `notifications/tasks`
   * while waiting, so changes arrive without waiting for the next poll;
   * default false. Polling continues as a backstop.
   */
  readonly notifications?: boolean;
}

/**
 * The methods that only read, which the client sends again after a lost
 * answer by default. `initialize`, `ping` and `tasks/list` are older or
 * optional methods, listed for servers that have them.
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "tasks/get",
  "tasks/list",
]);

/** When the client sends a request again; see {@link McpClientOptions.retry}. */
export interface ClientRetryOptions {
  /**
   * Whether sending `method` twice has the same effect as sending it once.
   * `byDefault` is the built-in answer, never true for a round carrying
   * `inputResponses` (answers to elicitation) without a key: true for
   * {@link READ_ONLY_METHODS}, and for a `tools/call` of a tool whose
   * listed definition (from the last
   * `listTools`, and no `tools/list_changed` since) has
   * `annotations.idempotentHint: true`, or that carries an
   * idempotency key to a server advertising durable deduplication. Return
   * true only for what the server really treats as idempotent.
   */
  readonly idempotent?: (
    method: string,
    params: Readonly<Record<string, unknown>>,
    byDefault: boolean,
  ) => boolean;
  /** Retries of one request after the first attempt; default 1, at most 10. */
  readonly max?: number;
}

/** Options for {@link McpClient}. */
export interface McpClientOptions {
  /** How requests reach the server. */
  readonly transport: Transport;
  /** The client's name and version, sent as `clientInfo` on every request. */
  readonly info: Implementation;
  /** Protocol versions in order of preference; default just 2026-07-28. */
  readonly versions?: readonly string[];
  /** Handlers for multi round-trip input requests; they set the capabilities. */
  readonly handlers?: InputHandlers;
  /** Extra capabilities to declare (extensions, experimental, sampling sub-capabilities). */
  readonly capabilities?: ClientCapabilities;
  /** A cache for results with `ttlMs`; default none. */
  readonly cache?: ResultCache;
  /**
   * Names the authorization context for `private` cache entries: a hash of
   * the credential, or the principal's ownership key. Entries are also kept
   * per endpoint. Required to cache private results; without it only
   * `public` ones are cached.
   */
  readonly cacheContext?: string;
  /**
   * Per-request timeout, reset by each progress notification, 1 ms to
   * 2^31 - 1 ms; default 60 s.
   */
  readonly timeoutMs?: number;
  /**
   * Cap on one request's total time, progress or not, 1 ms to 2^31 - 1 ms;
   * default 10 min.
   */
  readonly maxTimeoutMs?: number;
  /** Most `input_required` rounds per call, 0 to 32; default 8. */
  readonly maxInputRounds?: number;
  /**
   * When a failed request is sent again (with a new id). Only an idempotent
   * request is retried, after its response stream broke or its connection
   * failed; anything else that may have reached the server (those, a
   * timeout, an HTTP 5xx or 499) fails with `retryable: false`, since the
   * server may have acted on it. Default: reads and idempotent tools, once.
   */
  readonly retry?: ClientRetryOptions;
  /** Validate `structuredContent` against known output schemas; default true. */
  readonly validateToolOutput?: boolean;
  /** Told about tools dropped from `tools/list` and similar; default `console.warn`. */
  readonly onWarning?: (message: string) => void;
  /** Milliseconds since the epoch; for tests. */
  readonly now?: () => number;
  /**
   * Declares the tasks extension, so the server may answer `tools/call` with
   * a task; `callTool` then follows it to the end. Default false.
   */
  readonly tasks?: boolean | ClientTaskOptions;
}

/** Per-call options. */
export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Overrides the client's timeout for this call. */
  readonly timeoutMs?: number;
  /** Requests progress notifications and receives them. */
  readonly onProgress?: (progress: ProgressNotificationParams) => void;
  /** Requests log messages at this level and above (deprecated feature). */
  readonly logLevel?: LoggingLevel;
  /** Receives the log messages `logLevel` asked for. */
  readonly onLog?: (message: LoggingMessageNotificationParams) => void;
  /** Extra `_meta` entries, such as `traceparent`. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Skip the cache for this call (the fresh result is still stored). */
  readonly fresh?: boolean;
  /**
   * `callTool`: an idempotency key for this one logical call, sent as
   * `_meta["celld/idempotency-key"]` on every attempt and round. A server
   * with an idempotency store runs the call once per key. The client
   * retries a keyed call like a read only when the server advertises
   * durable deduplication (`IDEMPOTENCY_CAPABILITY` with `durable: true`,
   * from `server/discover`, which it asks after the failure when it does
   * not know yet); against any other server a retry could run the call
   * again, so the failure has `retryable: false`. Use a fresh random value
   * (a UUID) per call. 1-255 printable ASCII characters.
   */
  readonly idempotencyKey?: string;
  /** `callTool`: told when the server answered with a task, before waiting on it. */
  readonly onTask?: (task: TaskHandle) => void;
  /** `callTool`: told about each new state of that task. */
  readonly onTaskStatus?: (task: DetailedTask) => void;
}

/** What `startToolCall` got back: the result, or a task to follow. */
export type ToolCallStart =
  | { readonly type: "complete"; readonly result: CallToolResult }
  | { readonly type: "task"; readonly task: TaskHandle };

/** Options for {@link TaskHandle.result}. */
export interface TaskWaitOptions {
  readonly signal?: AbortSignal;
  /** Told about each new state of the task. */
  readonly onStatus?: (task: DetailedTask) => void;
  /** Send `tasks/cancel` if `signal` aborts; default false. */
  readonly cancelOnAbort?: boolean;
  /** Overrides the client's `tasks.notifications`. */
  readonly notifications?: boolean;
}

/** What a {@link TaskHandle} needs from its client. */
interface TaskPort {
  readonly options: ClientTaskOptions;
  request(
    method: string,
    params: Record<string, unknown>,
    options: CallOptions,
  ): Promise<Result>;
  fulfil(
    requests: InputRequests,
    name: string,
    taskId: string,
    signal: AbortSignal,
  ): Promise<InputResponses>;
  listen(
    filter: SubscriptionFilter,
    signal: AbortSignal,
    meta: Readonly<Record<string, unknown>>,
  ): Subscription;
  checkOutput(name: string, result: CallToolResult): void;
  /** Reports something the caller should know but that is not an error. */
  warn(message: string): void;
}

/**
 * A per-call `timeoutMs`, checked: 1 ms to 2^31 - 1 ms, else the McpError
 * `invalid_request` (before anything is sent).
 */
function checkedMs(value: number, name: string, method: string): number {
  try {
    return nonNegativeMs(value, { name, min: 1 });
  } catch (cause) {
    throw new McpError("invalid_request", (cause as Error).message, {
      method,
      cause,
    });
  }
}

/** The most listen notifications a subscription holds unread. */
const MAX_QUEUED_NOTIFICATIONS = 1000;

/** The longest poll interval a server may impose: five minutes. */
const MAX_POLL_FLOOR_MS = 300_000;

/** How long an abort's `tasks/cancel` may take before it counts as failed. */
const CANCEL_TIMEOUT_MS = 5000;

/** The longest a result is cached, whatever its `ttlMs`: a day. */
const MAX_CACHE_TTL_MS = 86_400_000;

/** How many pages `listAllTools` follows, and how many tools it keeps. */
const MAX_LIST_PAGES = 100;
const MAX_LIST_TOOLS = 10_000;

const DETAIL: Partial<Record<string, string>> = table({
  input_required: "inputRequests",
  completed: "result",
  failed: "error",
});

/** Whether a snapshot lacks the fields its status implies (a `CreateTaskResult`). */
function needsDetail(task: Task): boolean {
  const field = DETAIL[task.status];
  return field !== undefined && !(field in task);
}

/** Resolves after `ms`, on abort, or when `wake` is called. */
function pause(
  ms: number,
  signal: AbortSignal | undefined,
  hold: { wake: (() => void) | null },
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      hold.wake = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    hold.wake = done;
    if (signal?.aborted) done();
  });
}

/**
 * A task on the server: poll it, answer its input requests, cancel it, or
 * wait for its result. Get one from `startToolCall`, from `callTool`'s
 * `onTask`, or with `client.task(taskId)` to resume a task whose id was
 * kept (the extension advises persisting ids).
 *
 * A task started without credentials is reachable only with its
 * {@link token}, which the handle sends on every request for it; persist it
 * with the id to resume the task later.
 */
export class TaskHandle {
  readonly taskId: string;
  /** The tool it runs, when known. */
  readonly name: string | null;
  /**
   * The anonymous task's token (`_meta["celld/task-token"]` of the
   * creation result), or null for a task owned by the caller's credentials.
   * It is the only way to reach the task: keep it secret.
   */
  readonly token: string | null;
  readonly #port: TaskPort;
  #last: Task;

  /** @internal Use the client's methods. */
  constructor(
    port: TaskPort,
    first: Task,
    name: string | null,
    token: string | null = null,
  ) {
    this.#port = port;
    this.taskId = first.taskId;
    this.name = name;
    this.token = token;
    this.#last = first;
  }

  /** `options` with the task's token added to `_meta`, if it has one. */
  #withToken(options: CallOptions): CallOptions {
    if (this.token === null) return options;
    return { ...options, meta: { ...options.meta, [TASK_TOKEN]: this.token } };
  }

  /** The last state seen: the creation result's, or a later poll's. */
  get last(): Task {
    return this.#last;
  }

  /** `tasks/get`: the task's current state. */
  async get(options: CallOptions = {}): Promise<DetailedTask> {
    const task = await this.#port.request(
      "tasks/get",
      { taskId: this.taskId },
      this.#withToken(options),
    ) as unknown as DetailedTask;
    if (task.taskId !== this.taskId) {
      throw new McpError(
        "decode",
        `tasks/get for ${this.taskId} returned task ${task.taskId}`,
        { method: "tasks/get" },
      );
    }
    this.#last = task;
    return task;
  }

  /** `tasks/update`: answers outstanding input requests. */
  async update(
    responses: InputResponses,
    options: CallOptions = {},
  ): Promise<void> {
    await this.#port.request(
      "tasks/update",
      { taskId: this.taskId, inputResponses: responses },
      this.#withToken(options),
    );
  }

  /**
   * `tasks/cancel`: asks the server to cancel. Cancellation is cooperative;
   * the task may still finish another way.
   */
  async cancel(options: CallOptions = {}): Promise<void> {
    await this.#port.request(
      "tasks/cancel",
      { taskId: this.taskId },
      this.#withToken(options),
    );
  }

  /**
   * Follows the task to its end: polls `tasks/get` no faster than the
   * server's `pollIntervalMs` (backing off while nothing changes), answers
   * each new input request once through the client's handlers, and returns
   * the completed task's result. A failed task throws its JSON-RPC error as
   * an `rpc` McpError, a cancelled one `task_cancelled`.
   */
  async result(options: TaskWaitOptions = {}): Promise<CallToolResult> {
    const settings = this.#port.options;
    const initial = settings.initialPollMs ?? 500;
    const ceiling = settings.maxPollMs ?? 10_000;
    const maxErrors = settings.maxPollErrors ?? 5;
    const minimum = settings.minPollMs ?? 100;
    // The server's suggestion, held to [minimum, MAX_POLL_FLOOR_MS].
    const floorOf = (task: Task) =>
      Math.min(
        Math.max(task.pollIntervalMs ?? initial, minimum),
        MAX_POLL_FLOOR_MS,
      );
    const signal = options.signal;
    const answered = new Set<string>();
    const hold: { wake: (() => void) | null } = { wake: null };
    let pushed: DetailedTask | null = null;
    let subscription: Subscription | null = null;
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (options.notifications ?? settings.notifications ?? false) {
      subscription = this.#port.listen(
        { taskIds: [this.taskId] },
        stop.signal,
        this.token === null
          ? {}
          : { [TASK_TOKENS]: { [this.taskId]: this.token } },
      );
      void (async () => {
        try {
          for await (const notification of subscription!) {
            if (
              notification.method === "notifications/tasks" &&
              notification.params.taskId === this.taskId
            ) {
              pushed = notification.params as DetailedTask;
              hold.wake?.();
            }
          }
        } catch {
          // Polling carries on without notifications.
        }
      })();
    }
    let task = this.#last;
    let backoff = floorOf(task);
    let errors = 0;
    try {
      for (;;) {
        if (signal?.aborted) {
          // Whether the task was stopped is part of the answer: a caller
          // told only "aborted" cannot know a mutation may still finish.
          let cancelled: boolean | null = null;
          let cancelError: unknown = undefined;
          if (options.cancelOnAbort) {
            try {
              await this.cancel({ timeoutMs: CANCEL_TIMEOUT_MS });
              cancelled = true;
            } catch (error) {
              cancelled = false;
              cancelError = error;
              this.#port.warn(
                `task ${this.taskId} may still be running: tasks/cancel failed: ${
                  (error as Error)?.message ?? error
                }`,
              );
            }
          }
          throw new McpError("aborted", "the request was aborted", {
            method: "tools/call",
            cause: cancelError ?? signal.reason,
            data: cancelled === null
              ? { taskId: this.taskId }
              : { taskId: this.taskId, cancelled },
          });
        }
        if (!needsDetail(task)) {
          if (isTerminalStatus(task.status)) {
            return this.#finish(task as DetailedTask);
          }
          if (task.status === "input_required") {
            const requests = (task as DetailedTask & {
              inputRequests: InputRequests;
            }).inputRequests;
            // Keys are the server's: `__proto__` must stay an own key.
            const pending: InputRequests = bag();
            for (const [key, request] of Object.entries(requests)) {
              if (!answered.has(key)) pending[key] = request;
            }
            if (Object.keys(pending).length > 0) {
              const responses = await this.#port.fulfil(
                pending,
                this.name ?? "",
                this.taskId,
                signal ?? new AbortController().signal,
              );
              await this.update(responses, { signal });
              for (const key of Object.keys(pending)) answered.add(key);
            }
          }
          const floor = floorOf(task);
          await pause(
            Math.min(Math.max(backoff, floor), Math.max(ceiling, floor)),
            signal,
            hold,
          );
          if (signal?.aborted) continue;
        }
        const before = task;
        if (pushed !== null) {
          task = pushed;
          pushed = null;
        } else {
          try {
            task = await this.get({ signal });
            errors = 0;
          } catch (error) {
            if (
              error instanceof McpError && error.retryable &&
              ++errors <= maxErrors
            ) {
              backoff = Math.min(backoff * 2, Math.max(ceiling, backoff));
              continue;
            }
            throw error;
          }
        }
        this.#last = task;
        const changed = task.status !== before.status ||
          task.statusMessage !== before.statusMessage ||
          task.lastUpdatedAt !== before.lastUpdatedAt;
        if (changed) options.onStatus?.(task as DetailedTask);
        const floor = floorOf(task);
        backoff = task.status !== before.status
          ? floor
          : Math.min(Math.max(backoff, floor) * 2, Math.max(ceiling, floor));
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      stop.abort();
      subscription?.close();
    }
  }

  /** Like {@link result}, returning McpErrors as data. */
  tryResult(
    options: TaskWaitOptions = {},
  ): Promise<McpOutcome<CallToolResult>> {
    return attempt(() => this.result(options));
  }

  #finish(task: DetailedTask): CallToolResult {
    switch (task.status) {
      case "completed": {
        const result = {
          resultType: "complete",
          ...task.result,
        } as CallToolResult;
        const issues = check(result, RESULT["tools/call"]);
        if (issues.length > 0) {
          throw new McpError(
            "decode",
            `malformed result of task ${this.taskId}: ${formatIssues(issues)}`,
            { method: "tools/call" },
          );
        }
        if (this.name !== null) this.#port.checkOutput(this.name, result);
        return result;
      }
      case "failed":
        throw mcpErrorFromRpc(task.error, { method: "tools/call" });
      default:
        throw new McpError(
          "task_cancelled",
          task.statusMessage ?? `task ${this.taskId} was cancelled`,
          { method: "tools/call" },
        );
    }
  }
}

interface KnownTool {
  readonly headers: readonly ParamHeader[];
  readonly output: CompiledSchema | null;
  /** The definition had `annotations.idempotentHint: true`. */
  readonly idempotent: boolean;
}

/**
 * How an attempt failed, for `mayRetry`: a connection failure (`fetch`
 * rejected, no response), a body that broke after the response began
 * (`stream`: the server accepted the request), or anything else, which is
 * never retried here.
 */
function retryFailure(error: unknown): RetryFailure | null {
  if (!(error instanceof McpError)) return null;
  if (error.kind === "connection") return { kind: "connection" };
  if (error.kind === "stream") return { kind: "body" };
  return null;
}

/**
 * Whether a failure leaves open that the server ran the request: a lost
 * or broken answer (`connection`, `stream`), the client's own timeout, or
 * an HTTP 5xx or 499 without a JSON-RPC answer (a route's 504 "may still
 * take effect", a proxy's 502). Such a failure of a request that is not
 * idempotent is never `retryable`. A 429 or another 4xx is a refusal.
 */
function mayHaveRun(error: unknown): boolean {
  if (!(error instanceof McpError)) return false;
  switch (error.kind) {
    case "connection":
    case "stream":
    case "timeout":
      return true;
    case "http":
      return error.status !== null &&
        (error.status >= 500 || error.status === 499);
    default:
      return false;
  }
}

/** Whether a discovery result advertises durable keyed deduplication. */
function advertisesDurableDeduplication(result: DiscoverResult): boolean {
  const entry = result.capabilities?.experimental?.[IDEMPOTENCY_CAPABILITY];
  return isPlainObject(entry) && entry.durable === true;
}

/** The first wait before asking again for a keyed call still running. */
const IN_PROGRESS_FIRST_WAIT_MS = 25;
/** The longest wait between those asks. */
const IN_PROGRESS_MAX_WAIT_MS = 2_000;

/** Whether the server said a keyed call's first attempt is still running. */
function stillRunning(error: McpError): boolean {
  return error.kind === "rpc" && error.code === INVALID_REQUEST &&
    isPlainObject(error.data) && error.data.inProgress === true;
}

/** A `subscriptions/listen` stream. */
export interface Subscription extends AsyncIterable<ServerNotification> {
  /** The filter the server agreed to honour, once acknowledged. */
  readonly acknowledged: Promise<SubscriptionFilter>;
  /** Closes the stream, which ends the subscription on the server. */
  close(): void;
  /** Whether the server ended it with a graceful result (versus a drop). */
  readonly endedGracefully: boolean;
}

const MRTR = new Set(["tools/call", "prompts/get", "resources/read"]);

/** An MCP client. */
export class McpClient {
  readonly info: Implementation;
  readonly #options: McpClientOptions;
  readonly #transport: Transport;
  readonly #versions: readonly string[];
  #version: string;
  #nextId = 1;
  #progressId = 0;
  readonly #tools = new Map<string, KnownTool>();
  readonly #generations = new Map<string, number>();
  readonly #now: () => number;
  readonly #retryPolicy: HttpRetryPolicy;
  readonly #timeoutMs: number;
  readonly #maxTimeoutMs: number;
  readonly #maxInputRounds: number;
  /** See {@link McpClient.#deduplicates}; null until discovered. */
  #deduplicating: boolean | null = null;

  constructor(input: McpClientOptions) {
    // Read once: `cacheContext`, `versions` and the rest cannot be changed
    // on the caller's object afterwards.
    const options = snapshotOptions(input);
    this.#options = options;
    this.info = options.info;
    this.#transport = options.transport;
    this.#versions = Object.freeze([
      ...(options.versions ?? [LATEST_PROTOCOL_VERSION]),
    ]);
    if (this.#versions.length === 0) {
      throw new RangeError("versions must not be empty");
    }
    this.#version = this.#versions[0];
    this.#now = options.now ?? (() => Date.now());
    // Numbers that reach timers and loop bounds, checked once (RangeError).
    this.#timeoutMs = nonNegativeMs(options.timeoutMs ?? 60_000, {
      name: "timeoutMs",
      min: 1,
    });
    this.#maxTimeoutMs = nonNegativeMs(options.maxTimeoutMs ?? 600_000, {
      name: "maxTimeoutMs",
      min: 1,
    });
    this.#maxInputRounds = safeInt(options.maxInputRounds ?? 8, {
      name: "maxInputRounds",
      min: 0,
      max: 32,
    });
    const tasks = typeof options.tasks === "object" ? options.tasks : {};
    for (
      const [name, value, min, max] of [
        ["tasks.initialPollMs", tasks.initialPollMs, 1, MAX_POLL_FLOOR_MS],
        ["tasks.minPollMs", tasks.minPollMs, 1, 60_000],
        ["tasks.maxPollMs", tasks.maxPollMs, 1, MAX_POLL_FLOOR_MS],
      ] as const
    ) {
      if (value !== undefined) nonNegativeMs(value, { name, min, max });
    }
    if (tasks.maxPollErrors !== undefined) {
      safeInt(tasks.maxPollErrors, {
        name: "tasks.maxPollErrors",
        min: 0,
        max: 100,
      });
    }
    // Backoff and statuses are unused: a retry follows at once, and an
    // HTTP status is an answer, never retried.
    this.#retryPolicy = Object.freeze({
      maxRetries: safeInt(options.retry?.max ?? 1, {
        name: "retry.max",
        min: 0,
        max: 10,
      }),
      backoffInitialMs: 0,
      backoffMaxMs: 0,
      backoffJitter: 0,
      respectRetryAfter: false,
      maxRetryAfterMs: 0,
      statuses: [],
      retryConnectionErrors: true,
      retryTimeouts: false,
      budgetMs: null,
    });
  }

  /** A client for a Streamable HTTP endpoint. */
  static http(
    url: string | URL,
    options: Omit<McpClientOptions, "transport"> & HttpTransportOptions,
  ): McpClient {
    strictRecord(options as unknown, [
      "info",
      "versions",
      "handlers",
      "capabilities",
      "cache",
      "cacheContext",
      "timeoutMs",
      "maxTimeoutMs",
      "maxInputRounds",
      "retry",
      "validateToolOutput",
      "onWarning",
      "now",
      "tasks",
      "fetch",
      "headers",
      "auth",
      "maxAuthAttempts",
      "allowLoopbackForDevelopment",
      "maxResponseBytes",
      "maxStreamBytes",
    ], "HTTP client options");
    const {
      fetch,
      headers,
      auth,
      maxAuthAttempts,
      allowLoopbackForDevelopment,
      maxResponseBytes,
      maxStreamBytes,
      ...clientOptions
    } = options;
    return new McpClient({
      ...clientOptions,
      transport: httpTransport(url, {
        fetch,
        headers,
        auth,
        maxAuthAttempts,
        allowLoopbackForDevelopment,
        maxResponseBytes,
        maxStreamBytes,
      }),
    });
  }

  /**
   * A cache scope within this client's server: cached results are kept per
   * endpoint, so one cache shared by clients of two servers never serves
   * one server's answer for the other.
   */
  #cacheScope(scope: string): string {
    return `${this.#transport.endpoint ?? ""}\n${scope}`;
  }

  /** The protocol version requests currently use. */
  get protocolVersion(): string {
    return this.#version;
  }

  /** The capabilities every request declares. */
  get capabilities(): ClientCapabilities {
    const handlers = this.#options.handlers ?? {};
    const caps: ClientCapabilities = { ...this.#options.capabilities };
    if (handlers.elicitation !== undefined) {
      const modes = handlers.elicitationModes ?? ["form"];
      caps.elicitation = {};
      if (modes.includes("form")) caps.elicitation.form = {};
      if (modes.includes("url")) caps.elicitation.url = {};
    }
    if (handlers.sampling !== undefined) {
      caps.sampling = { ...this.#options.capabilities?.sampling };
    }
    if (handlers.roots !== undefined) caps.roots = {};
    if (this.#options.tasks) {
      caps.extensions = { ...caps.extensions, [TASKS_EXTENSION]: {} };
    }
    return caps;
  }

  /* Typed methods */

  /**
   * Asks the server for its versions, capabilities and identity, and
   * switches to the first of the client's versions it supports. Throws
   * `unsupported_version` when there is none.
   */
  async discover(options: CallOptions = {}): Promise<DiscoverResult> {
    const result = await this.#request(
      "server/discover",
      {},
      options,
    ) as DiscoverResult;
    const chosen = this.#versions.find((version) =>
      result.supportedVersions.includes(version)
    );
    if (chosen === undefined) {
      throw new McpError(
        "unsupported_version",
        `the server supports ${
          result.supportedVersions.join(", ")
        }, the client ${this.#versions.join(", ")}`,
        { method: "server/discover" },
      );
    }
    this.#version = chosen;
    this.#deduplicating = advertisesDurableDeduplication(result);
    return result;
  }

  /**
   * One page of tools. Tools whose `x-mcp-header` annotations break the
   * spec's rules are dropped, with a warning, as the spec requires.
   */
  async listTools(
    cursor?: string,
    options: CallOptions = {},
  ): Promise<ListToolsResult> {
    const params: Record<string, unknown> = {};
    if (cursor !== undefined) params.cursor = cursor;
    const result = await this.#request(
      "tools/list",
      params,
      options,
    ) as ListToolsResult;
    const kept: Tool[] = [];
    for (const tool of result.tools) {
      const headers = paramHeaders(tool.inputSchema);
      if (headers.issues.length > 0) {
        this.#warn(
          `dropping tool ${tool.name}: invalid x-mcp-header: ${
            formatIssues(headers.issues)
          }`,
        );
        this.#tools.delete(tool.name);
        continue;
      }
      let output: CompiledSchema | null = null;
      if (tool.outputSchema !== undefined) {
        try {
          output = compileSchema(tool.outputSchema);
        } catch {
          // A schema this validator does not support is not checked.
          output = null;
        }
      }
      this.#tools.delete(tool.name);
      this.#tools.set(tool.name, {
        headers: headers.headers,
        output,
        idempotent: tool.annotations?.idempotentHint === true,
      });
      // Bounded: the tools seen longest ago go first.
      for (const oldest of this.#tools.keys()) {
        if (this.#tools.size <= MAX_LIST_TOOLS) break;
        this.#tools.delete(oldest);
      }
      kept.push(tool);
    }
    return { ...result, tools: kept };
  }

  /**
   * Every tool, following cursors: at most 100 pages and 10 000 tools, and
   * never the same cursor twice (a `decode` McpError past either, or on a
   * loop). A complete listing also forgets tools the server no longer
   * lists.
   */
  async listAllTools(options: CallOptions = {}): Promise<Tool[]> {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0;; pages++) {
      if (pages >= MAX_LIST_PAGES) {
        throw new McpError(
          "decode",
          `tools/list went on for more than ${MAX_LIST_PAGES} pages`,
          { method: "tools/list" },
        );
      }
      const page = await this.listTools(cursor, options);
      tools.push(...page.tools);
      if (tools.length > MAX_LIST_TOOLS) {
        throw new McpError(
          "decode",
          `tools/list listed more than ${MAX_LIST_TOOLS} tools`,
          { method: "tools/list" },
        );
      }
      cursor = page.nextCursor;
      if (cursor === undefined) break;
      if (seen.has(cursor)) {
        throw new McpError(
          "decode",
          "tools/list repeated a cursor",
          { method: "tools/list" },
        );
      }
      seen.add(cursor);
    }
    const listed = new Set(tools.map((tool) => tool.name));
    for (const name of [...this.#tools.keys()]) {
      if (!listed.has(name)) this.#tools.delete(name);
    }
    return tools;
  }

  /**
   * Calls a tool, answering input requests along the way. Tool failures come
   * back as results with `isError: true`; protocol failures throw.
   * Arguments named by the tool's `x-mcp-header` annotations (from the last
   * `listTools`) are mirrored into `Mcp-Param-*` headers; if the server
   * rejects the headers, the client refreshes the tool list and retries once.
   *
   * With `tasks` enabled, a server may answer with a task instead; the call
   * then follows it to the end (see {@link TaskHandle.result}) and returns
   * its result, cancelling the task if `signal` aborts.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<CallToolResult> {
    const started = await this.startToolCall(name, args, options);
    if (started.type === "complete") return started.result;
    options.onTask?.(started.task);
    return await started.task.result({
      signal: options.signal,
      onStatus: options.onTaskStatus,
      cancelOnAbort: true,
    });
  }

  /**
   * Calls a tool and returns what the server answered: the result, or (with
   * `tasks` enabled) a {@link TaskHandle} to poll, answer, cancel or await.
   */
  async startToolCall(
    name: string,
    args: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<ToolCallStart> {
    const params = { name, arguments: args };
    let result: Result;
    try {
      result = await this.#rounds("tools/call", params, options);
    } catch (error) {
      if (!(error instanceof McpError) || error.code !== HEADER_MISMATCH) {
        throw error;
      }
      await this.listAllTools({ ...options, fresh: true });
      result = await this.#rounds("tools/call", params, options);
    }
    if (result.resultType === "task") {
      const token = isPlainObject(result._meta)
        ? result._meta[TASK_TOKEN]
        : undefined;
      return {
        type: "task",
        task: new TaskHandle(
          this.#taskPort,
          result as unknown as Task,
          name,
          isTaskToken(token) ? token : null,
        ),
      };
    }
    const complete = result as CallToolResult;
    this.#checkOutput(name, complete);
    return { type: "complete", result: complete };
  }

  /**
   * A handle on an existing task, such as one whose id was persisted, for
   * polling or resuming. `name` is the tool it runs, if known (for output
   * validation and input handler context); `options.token` is the task's
   * {@link TaskHandle.token}, needed for a task started without
   * credentials.
   */
  task(
    taskId: string,
    name: string | null = null,
    options: { readonly token?: string } = {},
  ): TaskHandle {
    if (options.token !== undefined && !isTaskToken(options.token)) {
      throw new McpError("invalid_request", "malformed task token");
    }
    const now = Temporal.Instant.fromEpochMilliseconds(this.#now()).toString({
      fractionalSecondDigits: 3,
    });
    return new TaskHandle(
      this.#taskPort,
      {
        taskId,
        status: "working",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: null,
      },
      name,
      options.token ?? null,
    );
  }

  get #taskPort(): TaskPort {
    const tasks = this.#options.tasks;
    return {
      options: typeof tasks === "object" ? tasks : {},
      request: (method, params, options) =>
        this.#request(method, params, options),
      fulfil: (requests, name, taskId, signal) =>
        this.#fulfil(requests, "tools/call", name, signal, taskId),
      listen: (filter, signal, meta) => this.listen(filter, { signal, meta }),
      checkOutput: (name, result) => this.#checkOutput(name, result),
      warn: (message) => this.#warn(message),
    };
  }

  /** Checks `structuredContent` against the tool's known output schema. */
  #checkOutput(name: string, result: CallToolResult): void {
    const known = this.#tools.get(name);
    if (
      !(this.#options.validateToolOutput ?? true) || !known?.output ||
      result.isError === true
    ) {
      return;
    }
    const issues = result.structuredContent === undefined
      ? [{
        path: ["structuredContent"],
        message: "is required by the outputSchema",
      }]
      : known.output.validate(result.structuredContent);
    if (issues.length > 0) {
      throw new McpError(
        "decode",
        `tool ${name} returned output that fails its outputSchema: ${
          formatIssues(issues)
        }`,
        { method: "tools/call" },
      );
    }
  }

  /** One page of prompts. */
  async listPrompts(
    cursor?: string,
    options: CallOptions = {},
  ): Promise<ListPromptsResult> {
    return await this.#request(
      "prompts/list",
      cursor === undefined ? {} : { cursor },
      options,
    ) as ListPromptsResult;
  }

  /** Gets a prompt, answering input requests along the way. */
  async getPrompt(
    name: string,
    args: Record<string, string> = {},
    options: CallOptions = {},
  ): Promise<GetPromptResult> {
    return await this.#rounds(
      "prompts/get",
      { name, arguments: args },
      options,
    ) as GetPromptResult;
  }

  /** One page of resources. */
  async listResources(
    cursor?: string,
    options: CallOptions = {},
  ): Promise<ListResourcesResult> {
    return await this.#request(
      "resources/list",
      cursor === undefined ? {} : { cursor },
      options,
    ) as ListResourcesResult;
  }

  /** One page of resource templates. */
  async listResourceTemplates(
    cursor?: string,
    options: CallOptions = {},
  ): Promise<ListResourceTemplatesResult> {
    return await this.#request(
      "resources/templates/list",
      cursor === undefined ? {} : { cursor },
      options,
    ) as ListResourceTemplatesResult;
  }

  /**
   * Reads a resource, answering input requests along the way. A missing
   * resource throws an McpError whose `resourceNotFound` is true.
   */
  async readResource(
    uri: string,
    options: CallOptions = {},
  ): Promise<ReadResourceResult> {
    return await this.#rounds(
      "resources/read",
      { uri },
      options,
    ) as ReadResourceResult;
  }

  /** Completion values for a prompt or resource template argument. */
  async complete(
    params: Omit<CompleteRequestParams, "_meta">,
    options: CallOptions = {},
  ): Promise<CompleteResult> {
    return await this.#request(
      "completion/complete",
      params as Record<string, unknown>,
      options,
    ) as CompleteResult;
  }

  /**
   * Any other request, such as an extension method: framed, sent with the
   * per-request `_meta`, and checked only for a known `resultType`.
   */
  async request(
    method: string,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<Result> {
    return await this.#request(method, params, options);
  }

  /**
   * Opens a `subscriptions/listen` stream. Iterate it for the notifications
   * the server acknowledged; iteration ends when the server closes the
   * subscription gracefully or `close()`/the signal ends it, and throws when
   * the stream drops (reconnecting is the caller's choice). List-changed and
   * resource-updated notifications also invalidate the client's cache.
   */
  listen(
    filter: SubscriptionFilter,
    options: {
      readonly signal?: AbortSignal;
      /** Extra `_meta` entries, such as `celld/task-tokens`. */
      readonly meta?: Readonly<Record<string, unknown>>;
    } = {},
  ): Subscription {
    const stop = new AbortController();
    const onAbort = () => stop.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) stop.abort();
    const id = this.#nextId++;
    const queue: ServerNotification[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;
    let graceful = false;
    let acknowledge!: (filter: SubscriptionFilter) => void;
    let reject!: (error: unknown) => void;
    const acknowledged = new Promise<SubscriptionFilter>((resolve, fail) => {
      acknowledge = resolve;
      reject = fail;
    });
    acknowledged.catch(() => {});
    let seenAck = false;

    const fail = (error: unknown) => {
      if (finished) return;
      failure = error;
      finished = true;
      reject(error);
      stop.abort();
      wake?.();
    };
    const onNotification = (notification: JSONRPCNotification) => {
      if (finished) return;
      let decoded: ServerNotification;
      try {
        decoded = this.#notification(notification);
      } catch (error) {
        fail(error);
        return;
      }
      const params = decoded.params as Record<string, unknown> | undefined;
      const tag = isPlainObject(params?._meta)
        ? params._meta[META.subscriptionId]
        : undefined;
      if (tag !== id) {
        fail(
          new McpError(
            "decode",
            `a listen notification carries subscriptionId ${
              JSON.stringify(tag ?? null)
            }, expected ${id}`,
          ),
        );
        return;
      }
      if (decoded.method === "notifications/subscriptions/acknowledged") {
        seenAck = true;
        acknowledge(
          (decoded.params as { notifications: SubscriptionFilter })
            .notifications,
        );
        return;
      }
      if (!seenAck) {
        fail(
          new McpError(
            "decode",
            "a listen notification arrived before the acknowledgement",
          ),
        );
        return;
      }
      void this.#invalidate(decoded);
      if (queue.length >= MAX_QUEUED_NOTIFICATIONS) {
        fail(
          new McpError(
            "stream",
            `more than ${MAX_QUEUED_NOTIFICATIONS} listen notifications were not read; the subscription is closed`,
          ),
        );
        return;
      }
      queue.push(decoded);
      wake?.();
    };

    const message = {
      jsonrpc: "2.0" as const,
      id,
      method: "subscriptions/listen",
      params: {
        notifications: filter,
        _meta: this.#meta({ ...options.meta }),
      },
    };
    this.#transport.request(message, {
      signal: stop.signal,
      headers: {},
      onNotification,
    }).then((response) => {
      if (finished) return;
      if ("error" in response) {
        fail(this.#rpcError(response, "subscriptions/listen"));
        return;
      }
      graceful = true;
      finished = true;
      if (!seenAck) {
        reject(
          new McpError(
            "decode",
            "the subscription ended before it was acknowledged",
          ),
        );
      }
      wake?.();
    }, (error) => {
      if (finished) return;
      if (stop.signal.aborted) {
        // Closed by the caller's signal: the iteration just ends.
        finished = true;
        reject(new McpError("aborted", "the subscription was closed"));
        wake?.();
        return;
      }
      fail(error);
    });

    const iterator: AsyncIterableIterator<ServerNotification> = {
      async next(): Promise<IteratorResult<ServerNotification>> {
        for (;;) {
          if (queue.length > 0) return { done: false, value: queue.shift()! };
          if (finished) {
            if (failure !== null) throw failure;
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      },
      return(): Promise<IteratorResult<ServerNotification>> {
        close();
        return Promise.resolve({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    const close = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (!finished) {
        finished = true;
        reject(new McpError("aborted", "the subscription was closed"));
      }
      stop.abort();
      wake?.();
    };
    return {
      acknowledged,
      close,
      get endedGracefully() {
        return graceful;
      },
      [Symbol.asyncIterator]: () => iterator,
    };
  }

  /* Machinery */

  #warn(message: string): void {
    if (this.#options.onWarning !== undefined) this.#options.onWarning(message);
    else console.warn(`mcp: ${message}`);
  }

  #meta(extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return {
      ...extra,
      [META.protocolVersion]: this.#version,
      [META.clientCapabilities]: this.capabilities,
      [META.clientInfo]: this.info,
    };
  }

  #notification(notification: JSONRPCNotification): ServerNotification {
    const shape = NOTIFICATION[notification.method];
    if (shape === undefined) {
      throw new McpError(
        "decode",
        `unknown notification ${notification.method}`,
      );
    }
    const issues = check(notification, shape);
    if (issues.length > 0) {
      throw new McpError(
        "decode",
        `malformed ${notification.method}: ${formatIssues(issues)}`,
      );
    }
    return notification as ServerNotification;
  }

  /** How many invalidations of `method` this client has seen. */
  #generation(method: string): number {
    return this.#generations.get(method) ?? 0;
  }

  async #invalidate(notification: ServerNotification): Promise<void> {
    // The tools' `idempotentHint` came from a listing that may now be
    // stale: no tool is retried until the next `listTools` says so again.
    if (notification.method === "notifications/tools/list_changed") {
      for (const [name, known] of this.#tools) {
        if (known.idempotent) {
          this.#tools.set(name, { ...known, idempotent: false });
        }
      }
    }
    const cache = this.#options.cache;
    if (cache === undefined) return;
    const bump = (method: string) =>
      this.#generations.set(method, this.#generation(method) + 1);
    switch (notification.method) {
      case "notifications/tools/list_changed":
        bump("tools/list");
        break;
      case "notifications/prompts/list_changed":
        bump("prompts/list");
        break;
      case "notifications/resources/list_changed":
        bump("resources/list");
        bump("resources/templates/list");
        break;
      case "notifications/resources/updated":
        bump("resources/read");
        break;
    }
    switch (notification.method) {
      case "notifications/tools/list_changed":
        await cache.invalidate("tools/list");
        break;
      case "notifications/prompts/list_changed":
        await cache.invalidate("prompts/list");
        break;
      case "notifications/resources/list_changed":
        await cache.invalidate("resources/list");
        await cache.invalidate("resources/templates/list");
        break;
      case "notifications/resources/updated":
        await cache.invalidate("resources/read", notification.params.uri);
        break;
    }
  }

  #rpcError(response: JSONRPCResponse, method: string): McpError {
    const error =
      (response as { error: { code: number; message: string; data?: unknown } })
        .error;
    const status = (response as unknown as Record<symbol, unknown>)[STATUS];
    return mcpErrorFromRpc(error, {
      method,
      status: typeof status === "number" ? status : null,
    });
  }

  /** The MRTR loop around {@link #request}. */
  async #rounds(
    method: "tools/call" | "prompts/get" | "resources/read",
    params: Record<string, unknown>,
    options: CallOptions,
  ): Promise<Result> {
    const max = this.#maxInputRounds;
    let retry: { inputResponses?: InputResponses; requestState?: string } = {};
    for (let round = 0; round <= max; round++) {
      const result = await this.#request(
        method,
        { ...params, ...retry },
        options,
        round > 0,
      );
      if (result.resultType !== "input_required") return result;
      if (round === max) break;
      const requests = result.inputRequests as InputRequests | undefined;
      retry = {};
      if (requests !== undefined && Object.keys(requests).length > 0) {
        retry.inputResponses = await this.#fulfil(
          requests,
          method,
          String(params[NAME_SOURCE[method]]),
          options.signal ?? new AbortController().signal,
        );
      }
      if (typeof result.requestState === "string") {
        retry.requestState = result.requestState;
      }
    }
    throw new McpError(
      "input_rounds",
      `${method} still needed input after ${max} rounds`,
      { method },
    );
  }

  async #fulfil(
    requests: InputRequests,
    method: string,
    name: string,
    signal: AbortSignal,
    taskId?: string,
  ): Promise<InputResponses> {
    const handlers = this.#options.handlers ?? {};
    // Keys are the server's: `__proto__` must stay an own key.
    const out: InputResponses = bag();
    for (const [key, request] of Object.entries(requests)) {
      const context: InputContext = taskId === undefined
        ? { key, method, name, signal }
        : { key, method, name, taskId, signal };
      let answer: unknown;
      switch (request.method) {
        case "elicitation/create": {
          const mode = request.params.mode ?? "form";
          const modes = handlers.elicitationModes ?? ["form"];
          if (handlers.elicitation === undefined || !modes.includes(mode)) {
            throw new McpError(
              "input_unhandled",
              `the server asked for ${mode}-mode elicitation (${key}), which the client does not handle`,
              { method },
            );
          }
          answer = await handlers.elicitation(request.params, context);
          const result = answer as ElicitResult;
          if (
            mode === "form" && result?.action === "accept" &&
            request.params.mode !== "url"
          ) {
            let issues;
            try {
              issues = compileSchema(request.params.requestedSchema).validate(
                result.content ?? {},
              );
            } catch {
              issues = null; // A schema this validator cannot check.
            }
            if (issues !== null && issues.length > 0) {
              throw new McpError(
                "invalid_request",
                `the elicitation handler's answer to ${key} does not match the requested schema: ${
                  formatIssues(issues)
                }`,
                { method },
              );
            }
          }
          break;
        }
        case "sampling/createMessage":
          if (handlers.sampling === undefined) {
            throw new McpError(
              "input_unhandled",
              `the server asked for sampling (${key}), which the client does not handle`,
              { method },
            );
          }
          answer = await handlers.sampling(request.params, context);
          break;
        case "roots/list":
          if (handlers.roots === undefined) {
            throw new McpError(
              "input_unhandled",
              `the server asked for roots (${key}), which the client does not handle`,
              { method },
            );
          }
          answer = await handlers.roots(context);
          break;
      }
      const issues = check(answer, INPUT_RESPONSE[request.method]);
      if (issues.length > 0) {
        throw new McpError(
          "invalid_request",
          `the ${request.method} handler returned ${formatIssues(issues)}`,
          { method },
        );
      }
      out[key] = answer as InputResponses[string];
    }
    return out;
  }

  #headers(
    method: string,
    params: Record<string, unknown>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    const source = NAME_SOURCE[method];
    if (source !== undefined && typeof params[source] === "string") {
      headers[HEADER.name] = encodeHeaderValue(params[source] as string);
    }
    if (method === "tools/call") {
      const known = this.#tools.get(params.name as string);
      for (const header of known?.headers ?? []) {
        let value: string | null;
        try {
          value = paramHeaderValue(
            argumentAt(
              params.arguments as Record<string, unknown>,
              header.path,
            ),
          );
        } catch (error) {
          throw new McpError(
            "invalid_request",
            `argument ${header.path.join(".")} of ${params.name}: ${
              (error as Error).message
            }`,
            { method },
          );
        }
        if (value !== null) headers[HEADER.paramPrefix + header.name] = value;
      }
    }
    return headers;
  }

  /**
   * One request (one round): cache lookup, version renegotiation, re-issue
   * after a broken stream, timeouts, and result validation.
   */
  async #request(
    method: string,
    params: Record<string, unknown>,
    options: CallOptions,
    retryRound = false,
  ): Promise<Result> {
    const cache = this.#options.cache;
    const cacheable = cache !== undefined && CACHEABLE_METHODS.has(method) &&
      !retryRound && params.inputResponses === undefined &&
      params.requestState === undefined;
    const context = this.#options.cacheContext;
    if (cacheable && !options.fresh) {
      const now = this.#now();
      for (
        const scope of context === undefined
          ? ["public"]
          : ["public", `private:${context}`]
      ) {
        const hit = await cache.get(
          cacheKey(method, params, this.#cacheScope(scope)),
        );
        if (hit !== undefined && now < hit.expiresAt) return hit.result;
      }
    }

    if (
      options.idempotencyKey !== undefined &&
      !isIdempotencyKey(options.idempotencyKey)
    ) {
      throw new McpError(
        "invalid_request",
        "idempotencyKey must be 1-255 printable ASCII characters",
        { method },
      );
    }
    let renegotiated = false;
    let retries = 0;
    let waits = 0;
    let idempotent: boolean | null = null;
    const generation = this.#generation(method);
    const started = this.#now();
    for (;;) {
      let response: JSONRPCResponse;
      try {
        response = await this.#send(method, params, options);
      } catch (error) {
        const failure = retryFailure(error);
        if (failure === null && !mayHaveRun(error)) throw error;
        idempotent ??= await this.#idempotent(method, params, options);
        // A rejected fetch does not prove the server never saw the request
        // (a reset while a tool runs looks the same), so only idempotent
        // requests are retried after any failure.
        if (
          failure !== null && idempotent &&
          retries < this.#retryPolicy.maxRetries &&
          mayRetry(this.#retryPolicy, failure, { idempotent })
        ) {
          retries++;
          continue;
        }
        if (idempotent) throw error;
        throw this.#notRetried(error as McpError, method);
      }
      if ("error" in response) {
        const error = this.#rpcError(response, method);
        // The first attempt of this keyed call is still running (its
        // client left, or another copy is out): ask again under the same
        // key, with backoff, for its answer, within the call's cap.
        if (
          method === "tools/call" && options.idempotencyKey !== undefined &&
          stillRunning(error)
        ) {
          const wait = Math.min(
            IN_PROGRESS_FIRST_WAIT_MS * 2 ** waits,
            IN_PROGRESS_MAX_WAIT_MS,
          );
          if (
            this.#now() - started + wait < this.#maxTimeoutMs &&
            !options.signal?.aborted
          ) {
            waits++;
            await pause(wait, options.signal, { wake: null });
            if (options.signal?.aborted) {
              throw new McpError("aborted", "the request was aborted", {
                method,
                cause: options.signal.reason,
              });
            }
            continue;
          }
        }
        if (error.code === UNSUPPORTED_PROTOCOL_VERSION && !renegotiated) {
          const supported = error.supportedVersions ?? [];
          const chosen = this.#versions.find((version) =>
            supported.includes(version)
          );
          if (chosen === undefined) {
            throw new McpError(
              "unsupported_version",
              `the server supports ${
                supported.join(", ") || "no listed version"
              }, the client ${this.#versions.join(", ")}`,
              { method, data: error.data, status: error.status },
            );
          }
          if (chosen !== this.#version) {
            this.#version = chosen;
            renegotiated = true;
            continue;
          }
        }
        throw error;
      }
      const result = this.#result(method, response.result);
      if (cacheable && result.resultType === "complete") {
        // The server's `ttlMs`, at most a day.
        const ttl = typeof result.ttlMs === "number" && result.ttlMs > 0
          ? Math.min(result.ttlMs, MAX_CACHE_TTL_MS)
          : 0;
        const scope = result.cacheScope === "public"
          ? "public"
          : context === undefined
          ? null
          : `private:${context}`;
        // Not when an invalidation came in while this request was out:
        // its answer may predate the change.
        if (
          ttl > 0 && scope !== null &&
          this.#generation(method) === generation
        ) {
          await cache.set(cacheKey(method, params, this.#cacheScope(scope)), {
            result,
            expiresAt: this.#now() + ttl,
            method,
            uri: method === "resources/read" ? params.uri as string : undefined,
          });
        }
      }
      return result;
    }
  }

  /** Whether `method` may be sent twice; see {@link ClientRetryOptions}. */
  async #idempotent(
    method: string,
    params: Record<string, unknown>,
    options: CallOptions,
  ): Promise<boolean> {
    // A round answering input requests (an accepted form: an approval) is
    // not a read, whatever the method or hint; only a key makes it safe.
    const answering = params.inputResponses !== undefined;
    let byDefault = !answering &&
      (READ_ONLY_METHODS.has(method) ||
        (method === "tools/call" &&
          this.#tools.get(params.name as string)?.idempotent === true));
    if (
      !byDefault && method === "tools/call" &&
      options.idempotencyKey !== undefined
    ) {
      byDefault = await this.#deduplicates(options);
    }
    const decide = this.#options.retry?.idempotent;
    if (decide === undefined) return byDefault;
    const verdict = decide(method, params, byDefault);
    if (typeof verdict !== "boolean") {
      throw new TypeError("retry.idempotent must return a boolean");
    }
    return verdict;
  }

  /**
   * Whether the server advertised durable deduplication of keyed calls
   * ({@link IDEMPOTENCY_CAPABILITY}), from the last `server/discover`;
   * asked now when no answer is known. A discovery that fails counts as
   * no: the call is then not sent again.
   */
  async #deduplicates(options: CallOptions): Promise<boolean> {
    if (this.#deduplicating !== null) return this.#deduplicating;
    let result: DiscoverResult;
    try {
      result = await this.#request("server/discover", {}, {
        signal: options.signal,
      }) as DiscoverResult;
    } catch {
      return false;
    }
    this.#deduplicating = advertisesDurableDeduplication(result);
    return this.#deduplicating;
  }

  /**
   * The failure of a request that was not retried because it is not
   * idempotent: `retryable: false` whatever the kind, since the server may
   * have acted on it (see {@link mayHaveRun}).
   */
  #notRetried(error: McpError, method: string): McpError {
    const what = error.kind === "stream"
      ? "its response broke off after the server accepted it"
      : error.kind === "timeout"
      ? "no answer came in time"
      : error.kind === "http"
      ? `the server answered ${error.status} without a result`
      : "the connection failed after it may have been sent";
    return new McpError(
      error.kind,
      `${method} failed: ${what}; the server may have executed it, so it was not sent again (${error.message})`,
      {
        status: error.status,
        method,
        cause: error,
        retryable: false,
        accepted: error.accepted,
      },
    );
  }

  #result(method: string, raw: Result): Result {
    const result = { ...raw } as Result;
    // Servers before 2026-07-28 omit resultType; that means complete.
    if (result.resultType === undefined) result.resultType = "complete";
    // The extension says tasks/get answers "complete", but one of its own
    // examples uses "task"; both mean the task's state.
    if (method === "tasks/get" && result.resultType === "task") {
      result.resultType = "complete";
    }
    if (result.resultType === "task") {
      if (!TASK_AUGMENTABLE.has(method)) {
        throw new McpError(
          "decode",
          `${method} answered with a task, which only tools/call may`,
          { method },
        );
      }
      if (!this.#options.tasks) {
        throw new McpError(
          "decode",
          "the server answered with a task, but the client did not declare the tasks extension",
          { method },
        );
      }
      const issues = check(result, createTaskResult);
      if (issues.length > 0) {
        throw new McpError(
          "decode",
          `malformed task result: ${formatIssues(issues)}`,
          { method },
        );
      }
      return result;
    }
    if (result.resultType === "input_required") {
      if (!MRTR.has(method)) {
        throw new McpError(
          "decode",
          `${method} answered input_required, which only tools/call, prompts/get and resources/read may`,
          { method },
        );
      }
      const issues = check(result, inputRequiredResult);
      if (issues.length > 0) {
        throw new McpError(
          "decode",
          `malformed input_required result: ${formatIssues(issues)}`,
          { method },
        );
      }
      for (const [key, request] of Object.entries(result.inputRequests ?? {})) {
        const requestIssues = check(request, inputRequest, [
          "inputRequests",
          key,
        ]);
        if (requestIssues.length > 0) {
          throw new McpError("decode", formatIssues(requestIssues), { method });
        }
      }
      return result;
    }
    if (result.resultType !== "complete") {
      throw new McpError(
        "decode",
        `unknown resultType ${JSON.stringify(result.resultType)}`,
        { method },
      );
    }
    const shape = RESULT[method as ClientRequestMethod];
    if (shape !== undefined) {
      const issues = check(result, shape);
      if (issues.length > 0) {
        throw new McpError(
          "decode",
          `malformed ${method} result: ${formatIssues(issues)}`,
          { method },
        );
      }
    }
    return result;
  }

  /** Sends once, with a fresh id, a timeout, progress and log routing. */
  async #send(
    method: string,
    params: Record<string, unknown>,
    options: CallOptions,
  ): Promise<JSONRPCResponse> {
    const id: RequestId = this.#nextId++;
    const extraMeta: Record<string, unknown> = { ...options.meta };
    if (method === "tools/call" && options.idempotencyKey !== undefined) {
      extraMeta[IDEMPOTENCY_KEY] = options.idempotencyKey;
    }
    let token: string | undefined;
    if (options.onProgress !== undefined) {
      token = `p${++this.#progressId}`;
      extraMeta[META.progressToken] = token;
    }
    if (options.logLevel !== undefined) {
      extraMeta[META.logLevel] = options.logLevel;
    }
    const message = {
      jsonrpc: "2.0" as const,
      id,
      method,
      params: { ...params, _meta: this.#meta(extraMeta) },
    };
    const headers = this.#headers(method, params);

    const controller = new AbortController();
    const caller = options.signal;
    const onAbort = () => controller.abort(caller?.reason);
    if (caller?.aborted) {
      throw new McpError("aborted", "the request was aborted", { method });
    }
    caller?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = options.timeoutMs === undefined
      ? this.#timeoutMs
      : checkedMs(options.timeoutMs, "timeoutMs", method);
    const maxMs = this.#maxTimeoutMs;
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    };
    let timer = setTimeout(expire, timeoutMs);
    const cap = setTimeout(expire, maxMs);

    const onNotification = (notification: JSONRPCNotification) => {
      let decoded: ServerNotification;
      try {
        decoded = this.#notification(notification);
      } catch (error) {
        this.#warn((error as Error).message);
        return;
      }
      if (decoded.method === "notifications/progress") {
        if (decoded.params.progressToken !== token) return;
        clearTimeout(timer);
        timer = setTimeout(expire, timeoutMs);
        options.onProgress?.(decoded.params);
      } else if (decoded.method === "notifications/message") {
        options.onLog?.(decoded.params);
      }
    };
    try {
      return await this.#transport.request(message, {
        signal: controller.signal,
        headers,
        onNotification,
      });
    } catch (error) {
      if (timedOut) {
        throw new McpError(
          "timeout",
          `${method} got no response within ${timeoutMs} ms`,
          { method, cause: error },
        );
      }
      if (caller?.aborted) {
        throw new McpError("aborted", "the request was aborted", {
          method,
          cause: error,
        });
      }
      if (error instanceof McpError && error.method === null) {
        error.method = method;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(cap);
      caller?.removeEventListener("abort", onAbort);
    }
  }
}
