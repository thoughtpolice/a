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
 * @module
 */

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
import { type CompiledSchema, compileSchema } from "./jsonschema.ts";
import { formatIssues, isPlainObject } from "./json.ts";
import { META } from "./meta.ts";
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
   * The longest wait between polls while nothing changes; default 10 s. A
   * server's larger `pollIntervalMs` still wins.
   */
  readonly maxPollMs?: number;
  /** Transient `tasks/get` failures tolerated in a row; default 5. */
  readonly maxPollErrors?: number;
  /**
   * Also open a `subscriptions/listen` stream for `notifications/tasks`
   * while waiting, so changes arrive without waiting for the next poll;
   * default false. Polling continues as a backstop.
   */
  readonly notifications?: boolean;
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
   * Names the authorization context for `private` cache entries (a hash of
   * the credential, a user id). Required to cache private results; without
   * it only `public` ones are cached.
   */
  readonly cacheContext?: string;
  /** Per-request timeout, reset by each progress notification; default 60 s. */
  readonly timeoutMs?: number;
  /** Cap on one request's total time, progress or not; default 10 min. */
  readonly maxTimeoutMs?: number;
  /** Most `input_required` rounds per call; default 8. */
  readonly maxInputRounds?: number;
  /** Re-issues (with a new id) after a broken response stream; default 1. */
  readonly reissueOnBrokenStream?: number;
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
  listen(filter: SubscriptionFilter, signal: AbortSignal): Subscription;
  checkOutput(name: string, result: CallToolResult): void;
}

const DETAIL: Partial<Record<string, string>> = {
  input_required: "inputRequests",
  completed: "result",
  failed: "error",
};

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
 */
export class TaskHandle {
  readonly taskId: string;
  /** The tool it runs, when known. */
  readonly name: string | null;
  readonly #port: TaskPort;
  #last: Task;

  /** @internal Use the client's methods. */
  constructor(port: TaskPort, first: Task, name: string | null) {
    this.#port = port;
    this.taskId = first.taskId;
    this.name = name;
    this.#last = first;
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
      options,
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
      options,
    );
  }

  /**
   * `tasks/cancel`: asks the server to cancel. Cancellation is cooperative;
   * the task may still finish another way.
   */
  async cancel(options: CallOptions = {}): Promise<void> {
    await this.#port.request("tasks/cancel", { taskId: this.taskId }, options);
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
    const signal = options.signal;
    const answered = new Set<string>();
    const hold: { wake: (() => void) | null } = { wake: null };
    let pushed: DetailedTask | null = null;
    let subscription: Subscription | null = null;
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (options.notifications ?? settings.notifications ?? false) {
      subscription = this.#port.listen({ taskIds: [this.taskId] }, stop.signal);
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
    let backoff = task.pollIntervalMs ?? initial;
    let errors = 0;
    try {
      for (;;) {
        if (signal?.aborted) {
          if (options.cancelOnAbort) {
            this.cancel().catch(() => {});
          }
          throw new McpError("aborted", "the request was aborted", {
            method: "tools/call",
            cause: signal.reason,
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
            const pending: InputRequests = {};
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
          const floor = task.pollIntervalMs ?? initial;
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
        const floor = task.pollIntervalMs ?? initial;
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
  readonly #now: () => number;

  constructor(options: McpClientOptions) {
    this.#options = options;
    this.info = options.info;
    this.#transport = options.transport;
    this.#versions = options.versions ?? [LATEST_PROTOCOL_VERSION];
    if (this.#versions.length === 0) {
      throw new RangeError("versions must not be empty");
    }
    this.#version = this.#versions[0];
    this.#now = options.now ?? (() => Date.now());
  }

  /** A client for a Streamable HTTP endpoint. */
  static http(
    url: string | URL,
    options: Omit<McpClientOptions, "transport"> & HttpTransportOptions,
  ): McpClient {
    return new McpClient({
      ...options,
      transport: httpTransport(url, options),
    });
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
      this.#tools.set(tool.name, { headers: headers.headers, output });
      kept.push(tool);
    }
    return { ...result, tools: kept };
  }

  /** Every tool, following cursors. */
  async listAllTools(options: CallOptions = {}): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listTools(cursor, options);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
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
      return {
        type: "task",
        task: new TaskHandle(this.#taskPort, result as unknown as Task, name),
      };
    }
    const complete = result as CallToolResult;
    this.#checkOutput(name, complete);
    return { type: "complete", result: complete };
  }

  /**
   * A handle on an existing task, such as one whose id was persisted, for
   * polling or resuming. `name` is the tool it runs, if known (for output
   * validation and input handler context).
   */
  task(taskId: string, name: string | null = null): TaskHandle {
    const now = Temporal.Instant.fromEpochMilliseconds(this.#now()).toString({
      fractionalSecondDigits: 3,
    });
    return new TaskHandle(this.#taskPort, {
      taskId,
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: null,
    }, name);
  }

  get #taskPort(): TaskPort {
    const tasks = this.#options.tasks;
    return {
      options: typeof tasks === "object" ? tasks : {},
      request: (method, params, options) =>
        this.#request(method, params, options),
      fulfil: (requests, name, taskId, signal) =>
        this.#fulfil(requests, "tools/call", name, signal, taskId),
      listen: (filter, signal) => this.listen(filter, { signal }),
      checkOutput: (name, result) => this.#checkOutput(name, result),
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
    options: { readonly signal?: AbortSignal } = {},
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
      queue.push(decoded);
      wake?.();
    };

    const message = {
      jsonrpc: "2.0" as const,
      id,
      method: "subscriptions/listen",
      params: {
        notifications: filter,
        _meta: this.#meta({}),
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

  async #invalidate(notification: ServerNotification): Promise<void> {
    const cache = this.#options.cache;
    if (cache === undefined) return;
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
    const max = this.#options.maxInputRounds ?? 8;
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
    const out: InputResponses = {};
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
        const hit = await cache.get(cacheKey(method, params, scope));
        if (hit !== undefined && now < hit.expiresAt) return hit.result;
      }
    }

    let renegotiated = false;
    let reissues = this.#options.reissueOnBrokenStream ?? 1;
    for (;;) {
      let response: JSONRPCResponse;
      try {
        response = await this.#send(method, params, options);
      } catch (error) {
        if (
          error instanceof McpError && error.kind === "stream" && reissues > 0
        ) {
          reissues--;
          continue;
        }
        throw error;
      }
      if ("error" in response) {
        const error = this.#rpcError(response, method);
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
        const ttl = typeof result.ttlMs === "number" && result.ttlMs > 0
          ? result.ttlMs
          : 0;
        const scope = result.cacheScope === "public"
          ? "public"
          : context === undefined
          ? null
          : `private:${context}`;
        if (ttl > 0 && scope !== null) {
          await cache.set(cacheKey(method, params, scope), {
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
    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs ?? 60_000;
    const maxMs = this.#options.maxTimeoutMs ?? 600_000;
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    };
    let timer = setTimeout(expire, timeoutMs);
    const cap = setTimeout(expire, Math.max(maxMs, 0));

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
