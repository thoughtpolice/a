// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `McpServer`: a registry of tools, resources, resource templates and
 * prompts, and a transport-independent dispatcher for MCP 2026-07-28
 * requests. `http.ts` puts it behind a Streamable HTTP `fetch` handler; the
 * `./testing` subpath connects a client to it in process.
 *
 * Every request is handled on its own, as the protocol is stateless: its
 * `_meta` supplies the protocol version and client capabilities, both
 * checked per request. Handlers get a {@link HandlerContext} with the
 * request's details, an AbortSignal that fires when the client goes away,
 * progress and log reporting (sent only when the request asked), and the
 * multi round-trip helpers: `ctx.elicit(key, params)` returns the client's
 * answer if this retry carries one, and otherwise ends the round with an
 * `InputRequiredResult`; the handler runs again, from the top, on the retry.
 *
 * @module
 */

import type { Principal } from "@celld/web/router";
import type { AnySchema, Schema as SieveSchema } from "@celld/sieve";
import { isSchema } from "@celld/sieve/introspect";
import { toJSONSchema } from "@celld/sieve/json-schema";
import { finite, nonNegativeMs, safeInt } from "@celld/core/bounds";
import { McpError } from "./errors.ts";
import { snapshotOptions } from "./snapshot.ts";
import {
  compileSchema,
  type JsonSchema,
  type SchemaLimits,
} from "./jsonschema.ts";
import {
  IDEMPOTENCY_CAPABILITY,
  IDEMPOTENCY_KEY,
  type IdempotencyOptions,
  idempotencyTtl,
  isIdempotencyKey,
} from "./idempotency.ts";
import {
  canonicalJson,
  formatIssues,
  fromBase64Url,
  isPlainObject,
  type Issue,
  sha256,
  toBase64,
  toBase64Url,
} from "./json.ts";
import { logLevelAtLeast, META } from "./meta.ts";
import {
  capabilityOwner,
  isTaskToken,
  newTaskToken,
  principalOwner,
  TASK_TOKEN,
  TASK_TOKENS,
} from "./ownership.ts";
import {
  capabilityFor,
  InputRequired,
  listRoots as rootsRequest,
  missingCapabilities,
} from "./mrtr.ts";
import { type ParamHeader, paramHeaders } from "./headers.ts";
import { paramsDigest, StateSealer } from "./state.ts";
import type {
  ChangeEvent,
  ChangePublisher,
  ChangeSource,
} from "./subscriptions.ts";
import {
  detailedTaskOf,
  newTaskId,
  taskOf,
  type TaskOutcome,
  type TaskRecord,
  type TaskRunHooks,
  type TaskRunner,
  type TaskStore,
} from "./task_store.ts";
import { checkMs, TASKS_EXTENSION } from "./tasks.ts";
import {
  check,
  contentBlock,
  INPUT_RESPONSE,
  isClientRequestMethod,
  MAX_LISTEN_URI_TOTAL,
  REQUEST_PARAMS,
  requestMeta,
} from "./validate.ts";
import {
  type Annotations,
  type BlobResourceContents,
  type CallToolResult,
  type ClientCapabilities,
  type ClientRequestMethod,
  type CompleteRequestParams,
  type ContentBlock,
  type CreateMessageRequestParams,
  type CreateMessageResult,
  type ElicitRequestParams,
  type ElicitResult,
  type GetPromptResult,
  type Icon,
  type Implementation,
  type InputRequest,
  type InputRequests,
  type InputResponse,
  type InputResponses,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type JSONValue,
  LATEST_PROTOCOL_VERSION,
  type ListRootsResult,
  type LoggingLevel,
  type MetaObject,
  type ProgressToken,
  type Prompt,
  type PromptArgument,
  type PromptMessage,
  type RequestId,
  type RequestMetaObject,
  type Resource,
  type ResourceTemplate,
  type Result,
  type ServerCapabilities,
  type SubscriptionFilter,
  type TextResourceContents,
  type Tool,
  type ToolAnnotations,
} from "./types.ts";

/**
 * Who made a request: `@celld/web/router`'s principal, as the route's auth
 * scheme established it. Its `key` (scheme, issuer, tenant, client id and
 * subject; never the subject alone) owns tasks, sealed `requestState` and
 * idempotency slots; handlers never see the credential itself.
 */
export type { Principal };

/** Cache hints for results the spec makes cacheable. */
export interface CacheHints {
  /**
   * Freshness in milliseconds, 0 to a day ({@link MAX_CACHE_TTL_MS}). The
   * server's `cache` default is checked when the server is made (a
   * `RangeError`); a handler's is clamped into that range.
   */
  readonly ttlMs?: number;
  /** `public` only when the result is the same for every caller. */
  readonly scope?: "public" | "private";
}

/** The facts of one request, as every handler and visibility check sees them. */
export interface RequestInfo {
  readonly requestId: RequestId;
  readonly method: ClientRequestMethod;
  readonly protocolVersion: string;
  readonly clientCapabilities: ClientCapabilities;
  /** Self-reported by the client; for display and logging only. */
  readonly clientInfo: Implementation | null;
  /** The request's whole `_meta`, including trace context. */
  readonly meta: RequestMetaObject;
  /** The authenticated caller, or null. */
  readonly principal: Principal | null;
  /**
   * Fires when the client cancels (closes the stream) or the server gives
   * up. The request is answered (or dropped) at that moment without waiting
   * for the handler, whose result is then discarded; the handler's own work
   * goes on until it observes this signal, so pass it to whatever it waits
   * on (fetches, timers, streams).
   */
  readonly signal: AbortSignal;
}

/** What a handler can do besides return. */
export interface HandlerContext extends RequestInfo {
  /**
   * Reports progress, if the request carried a progress token. Values must
   * increase; one that does not is dropped. No-op after the handler returns.
   */
  progress(
    progress: number,
    options?: { readonly total?: number; readonly message?: string },
  ): void;
  /**
   * Sends `notifications/message` on this request's stream, if the server
   * enables logging and the request asked for `level` or lower. Deprecated in
   * the spec (SEP-2577) but supported.
   */
  log(level: LoggingLevel, data: unknown, logger?: string): void;
  /** Throws -32021 unless the request declared these capabilities. */
  requireCapabilities(required: ClientCapabilities): void;

  /** The handler's own state from the previous round, or null. */
  readonly state: JSONValue | null;
  /** Sets the state sealed into the next `requestState`, if another round is needed. */
  setState(state: JSONValue | null): void;
  /** The verified answer to input request `key` from any earlier round. */
  input(key: string): InputResponse | undefined;
  /**
   * The client's answer to an elicitation, or (when there is none yet) ends
   * this round with an `InputRequiredResult` asking for it. Throws -32021 if
   * the client did not declare the needed elicitation mode.
   */
  elicit(key: string, params: ElicitRequestParams): ElicitResult;
  /**
   * The client's sampled message, asking for it first if needed.
   *
   * @deprecated Sampling is deprecated as of 2026-07-28 (SEP-2577).
   */
  sample(key: string, params: CreateMessageRequestParams): CreateMessageResult;
  /**
   * The client's roots, asking for them first if needed.
   *
   * @deprecated Roots are deprecated as of 2026-07-28 (SEP-2577).
   */
  roots(key: string): ListRootsResult;
  /**
   * Answers to several input requests at once: returns them all when every
   * one is answered, and otherwise asks for the unanswered ones in one round.
   */
  ask(requests: InputRequests): InputResponses;
  /**
   * Ends this round with an `InputRequiredResult` now. With no `requests`
   * the client retries at once; with `state`, that is sealed for the retry.
   */
  inputRequired(
    options?: { readonly requests?: InputRequests; readonly state?: JSONValue },
  ): never;
  /**
   * Hands this `tools/call` to the tool's task body: the server stores a new
   * task and answers with a `CreateTaskResult`. Only for tools with a
   * `task`; throws -32021 if the request did not declare the tasks
   * extension. Resolve any multi round-trip input first, as the extension
   * advises.
   */
  task(options?: StartTaskOptions): never;
}

/** Options for {@link HandlerContext.task}. */
export interface StartTaskOptions {
  /** The body's initial state (`ctx.state` in {@link TaskContext}). */
  readonly state?: JSONValue;
  /** The initial status message. */
  readonly statusMessage?: string;
  /** Overrides the tool's TTL; null for unlimited. */
  readonly ttlMs?: number | null;
  /** Overrides the tool's poll interval. */
  readonly pollIntervalMs?: number;
}

/**
 * What a task body sees. The body runs from the top on every run (after
 * each round of input, after a yield, and again if the host crashed), so it
 * must be safe to repeat up to the point where it asks; `save` keeps
 * progress across runs.
 */
export interface TaskContext {
  readonly taskId: string;
  /** The tool's name. */
  readonly name: string;
  /**
   * Who created the task, as it was then (null when anonymous). The body
   * runs as this snapshot to the end; `tasks/*` follow-ups are what the
   * server rechecks against the caller's current credential.
   */
  readonly principal: Principal | null;
  /** The creating request's version, capabilities and client info. */
  readonly protocolVersion: string;
  readonly clientCapabilities: ClientCapabilities;
  readonly clientInfo: Implementation | null;
  /**
   * Fires when the task is cancelled or expires. The run ends at that
   * moment without waiting for the body, whose outcome is discarded; the
   * body's own work goes on until it observes this signal.
   */
  readonly signal: AbortSignal;
  /** Which run this is, from 1. */
  readonly run: number;
  /** The state saved by an earlier run (or passed to `ctx.task`). */
  readonly state: JSONValue | null;
  /** Saves state durably for later runs. */
  save(state: JSONValue | null): Promise<void>;
  /** Sets the task's status message (and poll interval) while it works. */
  status(
    message: string | null,
    options?: { readonly pollIntervalMs?: number },
  ): Promise<void>;
  /** Throws -32021 unless the creating request declared these capabilities. */
  requireCapabilities(required: ClientCapabilities): void;
  /** The client's answer to input request `key`, if delivered. */
  input(key: string): InputResponse | undefined;
  /**
   * The client's answer to an elicitation, or (when there is none yet) ends
   * this run: the task becomes `input_required` until `tasks/update`
   * answers, then runs again.
   */
  elicit(key: string, params: ElicitRequestParams): ElicitResult;
  /** @deprecated Sampling is deprecated as of 2026-07-28 (SEP-2577). */
  sample(key: string, params: CreateMessageRequestParams): CreateMessageResult;
  /** @deprecated Roots are deprecated as of 2026-07-28 (SEP-2577). */
  roots(key: string): ListRootsResult;
  /** Answers to several input requests, asking for the missing ones in one round. */
  ask(requests: InputRequests): InputResponses;
  /**
   * Ends this run now. With requests, the task waits for them; without, it
   * yields and runs again after its poll interval (with `state`, if given).
   */
  inputRequired(
    options?: { readonly requests?: InputRequests; readonly state?: JSONValue },
  ): never;
}

/** A tool's asynchronous side, run as a task (the tasks extension). */
export interface TaskDefinition<I = Record<string, unknown>> {
  /** How long the task is kept after creation; default the server's; null for ever. */
  readonly ttlMs?: number | null;
  /** The polling interval suggested to clients; default the server's. */
  readonly pollIntervalMs?: number;
  /**
   * The work. Returns what a tool handler returns; the result becomes the
   * completed task's `result`. A thrown `ToolError` (or any non-JSON-RPC
   * failure) completes it with `isError: true`; a thrown JSON-RPC
   * `McpError` fails it.
   */
  run(args: I, ctx: TaskContext): ToolReturn | Promise<ToolReturn>;
}

/** Thrown by `ctx.task()`; the server turns it into a task. */
class TaskRequested extends Error {
  readonly options: StartTaskOptions;

  constructor(options: StartTaskOptions) {
    super("task requested");
    this.name = "TaskRequested";
    this.options = options;
  }
}

/** A tool execution error: becomes a result with `isError: true` and this message. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** What a tool handler returns: a text result, or result fields. */
export type ToolReturn =
  | string
  | {
    readonly content?: ContentBlock[];
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
    readonly _meta?: MetaObject;
  };

/** Display fields shared by definitions. */
interface Displayed {
  readonly title?: string;
  readonly description?: string;
  readonly icons?: Icon[];
  readonly _meta?: MetaObject;
  /** Whether this request may see the entry (lists and calls); default always. */
  readonly visible?: (info: RequestInfo) => boolean;
}

/**
 * A tool's argument or result schema: a `@celld/sieve` schema whose output
 * is `T`, or raw JSON Schema (then `T` is left to the caller).
 */
// deno-lint-ignore no-explicit-any
export type ToolSchema<T = unknown> = SieveSchema<T, any> | JsonSchema;

/** A tool. */
export interface ToolDefinition<I = Record<string, unknown>> extends Displayed {
  readonly name: string;
  readonly annotations?: ToolAnnotations;
  /**
   * The arguments' schema. A sieve object schema types the arguments: its
   * input form is the advertised `inputSchema` (`v.strictObject` for a
   * closed one, `v.looseObject` for an open one), arguments are parsed by
   * it, and the handler receives the parsed output. Raw JSON Schema with
   * `type: "object"` is validated as it is and the handler receives the
   * arguments unchanged. Default: no arguments.
   */
  readonly input?: ToolSchema<I>;
  /**
   * The schema of `structuredContent`; when set, the handler must return
   * conforming `structuredContent`. A sieve schema's output form is the
   * advertised `outputSchema`, and what the handler returns is parsed by
   * it before it is sent.
   */
  readonly output?: ToolSchema;
  /** Client capabilities the tool needs, checked (-32021) before it runs. */
  readonly requires?: ClientCapabilities;
  /**
   * The synchronous handler. It may call `ctx.task()` to continue as a
   * task. Without it, a tool with a `task` always runs as one (and a client
   * without the tasks extension gets -32021).
   */
  readonly run?: (
    args: I,
    ctx: HandlerContext,
  ) => ToolReturn | Promise<ToolReturn>;
  /** Runs the tool as a task; needs the server's `tasks` option. */
  readonly task?: TaskDefinition<I>;
  /**
   * OAuth scopes a caller needs to call the tool. The HTTP handler checks
   * them against the principal's and answers 403 `insufficient_scope`
   * naming them all; the server checks them too. They are stored with a
   * task the tool starts and with its sealed `requestState`, and every
   * follow-up checks them again against the caller's current scopes.
   */
  readonly scopes?: readonly string[];
}

/** What a resource read returns: text, bytes, contents, or null for "no such resource". */
export type ResourceReturn =
  | string
  | Uint8Array
  | (TextResourceContents | BlobResourceContents)[]
  | {
    readonly contents: (TextResourceContents | BlobResourceContents)[];
    readonly ttlMs?: number;
    readonly cacheScope?: "public" | "private";
  }
  | null;

/** A completion function: candidate values for one argument. */
export type Completer = (
  value: string,
  context: { readonly arguments: Readonly<Record<string, string>> },
  info: RequestInfo,
) =>
  | string[]
  | { values: string[]; total?: number; hasMore?: boolean }
  | Promise<string[] | { values: string[]; total?: number; hasMore?: boolean }>;

/** A fixed resource. */
export interface ResourceDefinition extends Displayed {
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly annotations?: Annotations;
  readonly size?: number;
  /** Cache hints for reads; default the server's. */
  readonly cache?: CacheHints;
  /** Client capabilities reading needs, checked (-32021) first. */
  readonly requires?: ClientCapabilities;
  read(ctx: HandlerContext): ResourceReturn | Promise<ResourceReturn>;
}

/**
 * A family of resources named by an RFC 6570 URI template. Supported
 * expressions: `{var}` (one segment, no `/`, `?` or `#`) and `{+var}` (any
 * characters). Values are percent-decoded.
 */
export interface ResourceTemplateDefinition extends Displayed {
  readonly uriTemplate: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly annotations?: Annotations;
  readonly cache?: CacheHints;
  readonly requires?: ClientCapabilities;
  /** Completions for template variables. */
  readonly complete?: Readonly<Record<string, Completer>>;
  read(
    uri: string,
    variables: Readonly<Record<string, string>>,
    ctx: HandlerContext,
  ): ResourceReturn | Promise<ResourceReturn>;
}

/** A prompt. */
export interface PromptDefinition extends Displayed {
  readonly name: string;
  readonly arguments?: PromptArgument[];
  /** Completions for arguments. */
  readonly complete?: Readonly<Record<string, Completer>>;
  readonly requires?: ClientCapabilities;
  get(
    args: Readonly<Record<string, string>>,
    ctx: HandlerContext,
  ):
    | PromptMessage[]
    | { description?: string; messages: PromptMessage[] }
    | Promise<
      PromptMessage[] | { description?: string; messages: PromptMessage[] }
    >;
}

/** Options for {@link McpServer}. */
export interface McpServerOptions {
  /** The server's name and version, sent in every result's `_meta`. */
  readonly info: Implementation;
  /** Guidance for models, returned by `server/discover`. */
  readonly instructions?: string;
  /** Protocol versions served; default just 2026-07-28. */
  readonly versions?: readonly string[];
  /**
   * The secret sealing `requestState` (at least 32 bytes). Required for any
   * handler that asks for input; every instance must share it.
   */
  readonly stateSecret?: string | Uint8Array;
  /**
   * What sealed `requestState` is bound to, so a state from another
   * server sharing `stateSecret` does not open here; default `info.name`.
   * Set it to the public endpoint URL when several deployments (staging
   * and production, a fleet of servers) share one secret and one name.
   */
  readonly stateAudience?: string;
  /**
   * How long a sealed `requestState` stays valid, 1 ms to 2^31 - 1 ms;
   * default 10 minutes.
   */
  readonly stateTtlMs?: number;
  /**
   * Where `subscriptions/listen` gets changes. Setting it advertises
   * `listChanged` (and resource `subscribe`).
   */
  readonly changes?: ChangeSource;
  /**
   * Close listen streams gracefully after this long, 1 ms to 2^31 - 1 ms;
   * default one hour. A stream also ends when the credential it was
   * opened with expires (`Principal.expiresAt`), whichever comes first;
   * the client reopens it (with a fresh token).
   */
  readonly listenLifetimeMs?: number;
  /** Declare the (deprecated) `logging` capability and send `ctx.log` messages. */
  readonly logging?: boolean;
  /** Items per page of list results; default 100. */
  readonly pageSize?: number;
  /**
   * Cache hints for `server/discover`, list results and reads without their
   * own; default `{ ttlMs: 60000, scope: "private" }`.
   */
  readonly cache?: CacheHints;
  /** Extra capabilities to advertise. */
  readonly capabilities?: Pick<
    ServerCapabilities,
    "extensions" | "experimental"
  >;
  /** Bounds for tool schemas. */
  readonly schemaLimits?: SchemaLimits;
  /**
   * Enables the tasks extension: advertises it, serves `tasks/get`,
   * `tasks/update` and `tasks/cancel`, and lets tools run as tasks. A task
   * belongs to its creator's `Principal.key`; an anonymous creator gets a
   * token (`TASK_TOKEN`) that every follow-up must carry instead.
   */
  readonly tasks?: TaskOptions;
  /**
   * Deduplicates `tools/call` requests carrying an idempotency key
   * (`_meta["celld/idempotency-key"]`): each runs at most once per caller,
   * tool, key and round, and duplicates get the stored answer. Without it
   * keys are ignored. See `IdempotencyStore`.
   */
  readonly idempotency?: IdempotencyOptions;
  /**
   * Most requests still running after their client left (a handler that
   * ignores its signal, or a keyed `tools/call`, which runs to the end so
   * its answer is recorded), 1 to 100 000; default 100. Past it, new
   * `tools/call`, `prompts/get` and `resources/read` requests are refused
   * with -32603 and `data: { busy: true }` before anything runs.
   */
  readonly maxAbandonedRequests?: number;
  /**
   * Told about unexpected handler failures (reported to the client as
   * -32603, or as a generic tool error). Default: `console.error`.
   */
  readonly onError?: (error: unknown, info: RequestInfo) => void;
  /** Milliseconds since the epoch; for tests. */
  readonly now?: () => number;
}

/** The server's task settings. */
export interface TaskOptions {
  /** Where tasks live: `UnsafeMemoryTaskStore` or `durableTaskStore(...)`. */
  readonly store: TaskStore;
  /** Default time to live; default one hour; null for ever. */
  readonly ttlMs?: number | null;
  /** Default suggested polling interval; default 1000 ms. */
  readonly pollIntervalMs?: number;
}

/** A request whose framing, `_meta`, version, method and params are checked. */
export interface PreparedRequest {
  readonly id: RequestId;
  readonly method: ClientRequestMethod;
  readonly params: Record<string, unknown>;
  readonly meta: RequestMetaObject;
}

/** Hooks a transport runs during {@link McpServer.prepare}. */
export interface PrepareHooks {
  /** After `_meta` is valid, before the version check (header vs body version). */
  readonly afterMeta?: (meta: RequestMetaObject) => void;
  /** After the params are valid (the `Mcp-Param-*` check). */
  readonly afterParams?: (request: PreparedRequest) => void;
}

/** Options for {@link McpServer.execute}. */
export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly principal?: Principal | null;
  /**
   * Receives the request's notifications (progress, log, and the listen
   * stream). Without it none are produced.
   */
  readonly emit?: (notification: JSONRPCNotification) => void | Promise<void>;
  /**
   * Whether granted scopes satisfy a required one, for the scopes the
   * server checks itself: a tool's `scopes` on `tools/call`, and the scopes
   * stored with a task or sealed state on every follow-up. Default exact
   * membership. The HTTP transport passes its `scopeSatisfied`.
   */
  readonly scopeSatisfied?: (
    granted: readonly string[],
    required: string,
  ) => boolean;
  /**
   * Keeps work alive after the response (a Worker's `ctx.waitUntil`): a
   * keyed call and the recording of its answer are held with it, so the
   * runtime does not cancel them once the response is sent. Other work
   * abandoned by an aborted request is not held (it only counts against
   * `maxAbandonedRequests`). The HTTP transport passes the request's.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** The longest cache freshness a result may state: a day. */
export const MAX_CACHE_TTL_MS = 86_400_000;

/** The default {@link McpServerOptions.listenLifetimeMs}: an hour. */
const DEFAULT_LISTEN_LIFETIME_MS = 3_600_000;

/** What {@link McpServer} checks before running a tool or a follow-up. */
function exactScope(granted: readonly string[], scope: string): boolean {
  return granted.includes(scope);
}

/** Both lists' scopes, once each. */
function scopeUnion(
  a: readonly string[],
  b: readonly string[],
): readonly string[] {
  return [...new Set([...a, ...b])];
}

/** The server's own scope refusals; see {@link isScopeRefusal}. */
const SCOPE_REFUSALS = new WeakSet<McpError>();

/**
 * Whether `error` is the server's own refusal of a caller whose credential
 * lacks scopes, made before anything ran: the only error
 * `McpServer.execute` rejects with, and the only one a transport may turn
 * into `403 insufficient_scope`. A client steps up and sends the request
 * again on that challenge, so an `unauthorized` McpError a handler throws
 * (an inner client's refusal, after the handler's own side effects) never
 * counts: it is a failure of the request like any other.
 */
export function isScopeRefusal(error: unknown): error is McpError {
  return error instanceof McpError && SCOPE_REFUSALS.has(error);
}

/**
 * The refusal for a caller whose credential lacks `required` scopes: not a
 * JSON-RPC error but what the transport answers with `403
 * insufficient_scope` naming them, so the client may step up.
 */
function insufficientScope(
  required: readonly string[],
  missing: readonly string[],
): McpError {
  const error = new McpError(
    "unauthorized",
    `Missing scopes: ${missing.join(" ")}`,
    {
      status: 403,
      data: { error: "insufficient_scope", scope: [...required] },
    },
  );
  SCOPE_REFUSALS.add(error);
  return error;
}

/** A request's sealed state, opened and checked. */
interface OpenedState {
  /** {@link paramsDigest} of the request. */
  readonly digest: string;
  /** The caller's principal key, or null. */
  readonly principal: string | null;
  /** The scopes the next round's state carries. */
  readonly scopes: readonly string[];
  readonly answers: InputResponses;
  readonly state: JSONValue | null;
}

/** A value checked against a tool schema: the parsed value, or the issues. */
type Checked =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/** A tool schema ready to use: its JSON Schema and its check. */
interface ToolSchemaEntry {
  readonly json: JsonSchema;
  check(value: unknown): Promise<Checked>;
}

interface ToolEntry {
  readonly definition: ToolDefinition<unknown>;
  readonly tool: Tool;
  readonly input: ToolSchemaEntry;
  readonly output: ToolSchemaEntry | null;
  readonly headers: ParamHeader[];
}

/**
 * A tool schema's JSON Schema and check: a sieve schema's `io` form, parsed
 * with `safeParseAsync`; raw JSON Schema compiled and validated as it is.
 */
function toolSchema(
  schema: ToolSchema,
  io: "input" | "output",
  limits: SchemaLimits | undefined,
): ToolSchemaEntry {
  if (isSchema(schema)) {
    const sieve = schema as AnySchema;
    return {
      json: toJSONSchema(sieve, { io, $schema: false }),
      async check(value) {
        const result = await sieve.safeParseAsync(value);
        return result.success ? { ok: true, value: result.data } : {
          ok: false,
          issues: result.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        };
      },
    };
  }
  if ("~standard" in schema) {
    throw new TypeError(
      "only @celld/sieve schemas and raw JSON Schema are supported",
    );
  }
  // The server's own schema: its patterns are evaluated.
  const compiled = compileSchema(schema, { ...limits, trustPatterns: true });
  return {
    json: schema,
    check(value) {
      const issues = compiled.validate(value);
      return Promise.resolve(
        issues.length === 0 ? { ok: true, value } : { ok: false, issues },
      );
    },
  };
}

interface TemplateEntry {
  readonly definition: ResourceTemplateDefinition;
  readonly template: UriTemplate;
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** One piece of a {@link UriTemplate}. */
type TemplatePart =
  | { readonly literal: string }
  | { readonly variable: string; readonly reserved: boolean };

/**
 * A compiled URI template (RFC 6570 levels 1 and 2: `{var}` and `{+var}`).
 * Matching takes time linear in the URI's length times the template's,
 * whatever the URI: it never backtracks the way a regular expression of
 * the same template would, so a client's URI cannot pin the isolate.
 */
export interface UriTemplate {
  /** The variables, in template order. */
  readonly variables: readonly string[];
  /** Whether `uri` matches. */
  test(uri: string): boolean;
  /**
   * The raw (still percent-encoded) value of each variable, in order, or
   * null when `uri` does not match. As a regular expression would: a
   * `{var}` (no `/`, `?` or `#`) takes as much as it can, a `{+var}` (any
   * character) as little, leaving the rest able to match.
   */
  match(uri: string): string[] | null;
}

/** Whether a variable of this kind may hold `char`. */
function holds(reserved: boolean, char: string): boolean {
  return reserved || (char !== "/" && char !== "?" && char !== "#");
}

/**
 * Parses a URI template into a matcher, or throws `TypeError` for
 * unsupported syntax. See {@link UriTemplate}.
 */
export function compileUriTemplate(template: string): UriTemplate {
  const variables: string[] = [];
  const parts: TemplatePart[] = [];
  let rest = template;
  while (rest.length > 0) {
    const open = rest.indexOf("{");
    const literal = open === -1 ? rest : rest.slice(0, open);
    if (literal.includes("}")) {
      throw new TypeError(`unbalanced } in URI template ${template}`);
    }
    if (literal !== "") parts.push({ literal });
    if (open === -1) break;
    const close = rest.indexOf("}", open);
    if (close === -1) {
      throw new TypeError(`unbalanced { in URI template ${template}`);
    }
    const expression = rest.slice(open + 1, close);
    const reserved = expression.startsWith("+");
    const name = reserved ? expression.slice(1) : expression;
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      throw new TypeError(
        `unsupported URI template expression {${expression}}: only {var} and {+var}`,
      );
    }
    if (variables.includes(name)) {
      throw new TypeError(`variable ${name} appears twice in ${template}`);
    }
    variables.push(name);
    parts.push({ variable: name, reserved });
    rest = rest.slice(close + 1);
  }

  /**
   * `ends[i][p]`: whether the URI from position `p` on matches parts `i`
   * onwards. Computed from the end, one pass per part: a literal checks
   * itself at `p`; a variable needs a later position `q > p` that the rest
   * matches from, with every character in between one it may hold.
   */
  const suffixes = (uri: string): Uint8Array[] => {
    const n = uri.length;
    const ends: Uint8Array[] = new Array(parts.length + 1);
    ends[parts.length] = new Uint8Array(n + 1);
    ends[parts.length][n] = 1;
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      const next = ends[i + 1];
      const here = new Uint8Array(n + 1);
      if ("literal" in part) {
        const length = part.literal.length;
        for (let p = 0; p + length <= n; p++) {
          if (next[p + length] === 1 && uri.startsWith(part.literal, p)) {
            here[p] = 1;
          }
        }
      } else {
        // From the right: can a nonempty run of held characters starting
        // at p end where the rest matches?
        let reachable = false;
        for (let p = n - 1; p >= 0; p--) {
          if (!holds(part.reserved, uri[p])) reachable = false;
          else {
            reachable = reachable || next[p + 1] === 1;
            if (reachable) here[p] = 1;
          }
        }
      }
      ends[i] = here;
    }
    return ends;
  };

  const match = (uri: string): string[] | null => {
    const ends = suffixes(uri);
    if (ends[0][0] !== 1) return null;
    const values: string[] = [];
    let p = 0;
    parts.forEach((part, i) => {
      if ("literal" in part) {
        p += part.literal.length;
        return;
      }
      const next = ends[i + 1];
      let end = -1;
      for (let q = p + 1; q <= uri.length; q++) {
        if (!holds(part.reserved, uri[q - 1])) break;
        if (next[q] === 1) {
          end = q;
          // The shortest for {+var}; the longest for {var}.
          if (part.reserved) break;
        }
      }
      values.push(uri.slice(p, end));
      p = end;
    });
    return values;
  };

  // The literals a match must start and end with: checked first, so most
  // URIs are ruled out without building the table.
  const first = parts[0];
  const last = parts[parts.length - 1];
  const prefix = first !== undefined && "literal" in first ? first.literal : "";
  const suffix = last !== undefined && "literal" in last && parts.length > 1
    ? last.literal
    : "";
  const possible = (uri: string) =>
    uri.length >= prefix.length + suffix.length && uri.startsWith(prefix) &&
    uri.endsWith(suffix);

  return Object.freeze({
    variables: Object.freeze([...variables]),
    test: (uri: string) => possible(uri) && suffixes(uri)[0][0] === 1,
    match: (uri: string) => possible(uri) ? match(uri) : null,
  });
}

function encodeCursor(after: string): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify({ a: after })));
}

function decodeCursor(cursor: string): string {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(cursor)));
    if (isPlainObject(value) && typeof value.a === "string") return value.a;
  } catch {
    // Falls through to the error below.
  }
  throw McpError.invalidParams("Invalid cursor", { cursor });
}

/** What {@link unlessAborted} resolves to when the signal won. */
const ABANDONED: unique symbol = Symbol("abandoned");

/** How abandoned work settled, for logging. */
type LateOutcome = { readonly value: unknown } | { readonly error: unknown };

/**
 * `work`'s outcome, or {@link ABANDONED} as soon as `signal` aborts, so a
 * handler that ignores its signal cannot hold the request. The abandoned
 * work keeps running until it notices the signal; `late` receives how it
 * settled, and its rejection is never left unhandled.
 */
function unlessAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late: (outcome: LateOutcome) => void,
): Promise<T | typeof ABANDONED> {
  return new Promise((resolve, reject) => {
    const abandon = () => {
      resolve(ABANDONED);
      work.then((value) => late({ value }), (error) => late({ error }));
    };
    work.then((value) => {
      signal.removeEventListener("abort", abandon);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abandon);
      reject(error);
    });
    if (signal.aborted) abandon();
    else signal.addEventListener("abort", abandon, { once: true });
  });
}

/** `record[name]` when `name` is one of its own keys (never Object.prototype's). */
function ownEntry<T>(
  record: Readonly<Record<string, T>> | undefined,
  name: string,
): T | undefined {
  return record !== undefined && Object.hasOwn(record, name)
    ? record[name]
    : undefined;
}

function abortedPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The longest delay a timer takes (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** An MCP server: register features, then hand requests to a transport. */
export class McpServer {
  readonly info: Implementation;
  readonly versions: readonly string[];
  readonly #options: McpServerOptions;
  readonly #tools = new Map<string, ToolEntry>();
  readonly #resources = new Map<string, ResourceDefinition>();
  readonly #templates = new Map<string, TemplateEntry>();
  readonly #prompts = new Map<string, PromptDefinition>();
  readonly #sealer: StateSealer | null;
  readonly #now: () => number;
  readonly #taskRunner: TaskRunner;
  readonly #idempotencyTtl: number;
  readonly #maxAbandoned: number;
  /** Requests still running after their client left. */
  #abandoned = 0;

  /**
   * Options are copied when the server is made (lists and plain data
   * frozen; stores, sources and callbacks kept as given), so changing the
   * caller's object afterwards changes nothing. Throws `TypeError` for an
   * empty or malformed `versions` list and `RangeError` for a bad
   * `listenLifetimeMs`, `stateTtlMs` or `pageSize`.
   */
  constructor(input: McpServerOptions) {
    const options = snapshotOptions(input);
    this.#options = options;
    this.info = options.info;
    const versions = options.versions ?? [LATEST_PROTOCOL_VERSION];
    if (
      !Array.isArray(versions) || versions.length === 0 ||
      !versions.every((version) => typeof version === "string" && version)
    ) {
      throw new TypeError("versions must be a non-empty list of versions");
    }
    this.versions = Object.freeze([...versions]);
    for (
      const [name, value] of [
        ["listenLifetimeMs", options.listenLifetimeMs],
        ["stateTtlMs", options.stateTtlMs],
      ] as const
    ) {
      if (value !== undefined) nonNegativeMs(value, { name, min: 1 });
    }
    if (options.pageSize !== undefined) {
      safeInt(options.pageSize, { name: "pageSize", min: 1, max: 10_000 });
    }
    this.#sealer = options.stateSecret === undefined ? null : new StateSealer(
      options.stateSecret,
      options.stateAudience ?? options.info.name,
    );
    this.#now = options.now ?? (() => Date.now());
    this.#idempotencyTtl = options.idempotency === undefined
      ? 0
      : idempotencyTtl(options.idempotency);
    this.#maxAbandoned = safeInt(options.maxAbandonedRequests ?? 100, {
      name: "maxAbandonedRequests",
      min: 1,
      max: 100_000,
    });
    const cache = options.cache;
    if (cache?.ttlMs !== undefined) {
      finite(cache.ttlMs, {
        name: "cache.ttlMs",
        min: 0,
        max: MAX_CACHE_TTL_MS,
      });
    }
    this.#taskRunner = {
      run: (record, hooks) => this.#runTask(record, hooks),
      changed: (taskId) => this.#taskChanged(taskId),
    };
    if (options.tasks !== undefined) {
      checkMs(options.tasks.ttlMs, "tasks.ttlMs", 1);
      checkMs(options.tasks.pollIntervalMs, "tasks.pollIntervalMs", 1);
      options.tasks.store.attach?.(this.#taskRunner);
    }
  }

  /**
   * Runs this server's task bodies; a store that runs them elsewhere (the
   * `McpTaskObject` Durable Object) builds the server there and uses this.
   */
  get taskRunner(): TaskRunner {
    return this.#taskRunner;
  }

  /* Registration */

  /**
   * Registers a tool. Throws if the name is taken or not a valid tool name,
   * a schema does not compile, or an `x-mcp-header` annotation is invalid.
   */
  tool<I>(given: ToolDefinition<I>): this {
    // Copied now: changing the caller's `scopes` (who may call it) or any
    // other member afterwards changes nothing.
    const definition = snapshotOptions(given);
    const { name } = definition;
    if (!TOOL_NAME.test(name)) {
      throw new TypeError(
        `tool name ${JSON.stringify(name)} must be 1-128 of A-Z a-z 0-9 _ - .`,
      );
    }
    if (this.#tools.has(name)) throw new TypeError(`duplicate tool ${name}`);
    const scopes: unknown = definition.scopes;
    if (
      scopes !== undefined &&
      (!Array.isArray(scopes) ||
        !scopes.every((scope) =>
          typeof scope === "string" && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)
        ))
    ) {
      throw new TypeError(
        `tool ${name}: scopes must be a list of OAuth scope strings`,
      );
    }
    if (definition.run === undefined && definition.task === undefined) {
      throw new TypeError(`tool ${name} needs run, task, or both`);
    }
    if (definition.task !== undefined) {
      if (this.#options.tasks === undefined) {
        throw new TypeError(
          `tool ${name} runs as a task, but the server has no tasks option`,
        );
      }
      checkMs(definition.task.ttlMs, `tool ${name}: task.ttlMs`, 1);
      checkMs(
        definition.task.pollIntervalMs,
        `tool ${name}: task.pollIntervalMs`,
        1,
      );
    }
    const limits = this.#options.schemaLimits;
    let input: ToolSchemaEntry;
    let output: ToolSchemaEntry | null;
    try {
      input = toolSchema(
        definition.input ?? { type: "object", additionalProperties: false },
        "input",
        limits,
      );
      output = definition.output === undefined
        ? null
        : toolSchema(definition.output, "output", limits);
    } catch (error) {
      throw new TypeError(`tool ${name}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    const rawInput = input.json;
    if (rawInput.type !== "object") {
      throw new TypeError(`tool ${name}: inputSchema must have type "object"`);
    }
    const rawOutput = output?.json;
    const headers = paramHeaders(rawInput);
    if (headers.issues.length > 0) {
      throw new TypeError(
        `tool ${name}: invalid x-mcp-header: ${formatIssues(headers.issues)}`,
      );
    }
    const tool: Tool = {
      name,
      inputSchema: rawInput as Tool["inputSchema"],
    };
    if (definition.title !== undefined) tool.title = definition.title;
    if (definition.description !== undefined) {
      tool.description = definition.description;
    }
    if (rawOutput !== undefined) tool.outputSchema = rawOutput;
    if (definition.annotations !== undefined) {
      tool.annotations = definition.annotations;
    }
    if (definition.icons !== undefined) tool.icons = definition.icons;
    if (definition._meta !== undefined) tool._meta = definition._meta;
    this.#tools.set(name, {
      definition: definition as ToolDefinition<unknown>,
      tool,
      input,
      output,
      headers: headers.headers,
    });
    return this;
  }

  /** Registers a fixed resource. */
  resource(input: ResourceDefinition): this {
    const definition = snapshotOptions(input);
    if (this.#resources.has(definition.uri)) {
      throw new TypeError(`duplicate resource ${definition.uri}`);
    }
    this.#resources.set(definition.uri, definition);
    return this;
  }

  /** Registers a resource template. Throws on unsupported template syntax. */
  resourceTemplate(input: ResourceTemplateDefinition): this {
    const definition = snapshotOptions(input);
    if (this.#templates.has(definition.uriTemplate)) {
      throw new TypeError(
        `duplicate resource template ${definition.uriTemplate}`,
      );
    }
    const template = compileUriTemplate(definition.uriTemplate);
    this.#templates.set(definition.uriTemplate, { definition, template });
    return this;
  }

  /** Registers a prompt. */
  prompt(input: PromptDefinition): this {
    const definition = snapshotOptions(input);
    if (this.#prompts.has(definition.name)) {
      throw new TypeError(`duplicate prompt ${definition.name}`);
    }
    this.#prompts.set(definition.name, definition);
    return this;
  }

  /**
   * The OAuth scopes a prepared request needs up front: a tool's `scopes`,
   * for `tools/call`. Transports check them before running the request.
   * Follow-ups (`tasks/*`, listen streams naming tasks, later rounds of a
   * multi round-trip request) need the scopes stored with the task or the
   * sealed state, which only the stored record knows: `execute` checks
   * those itself and rejects with an `unauthorized` McpError (status 403,
   * `data: { error: "insufficient_scope", scope }`), which the HTTP
   * transport turns into `403 insufficient_scope`.
   */
  requiredScopes(request: PreparedRequest): readonly string[] {
    if (request.method !== "tools/call") return [];
    return this.#tools.get(request.params.name as string)?.definition.scopes ??
      [];
  }

  /** The `x-mcp-header` annotations of a registered tool, for transports. */
  paramHeadersOf(name: string): readonly ParamHeader[] | null {
    return this.#tools.get(name)?.headers ?? null;
  }

  /** The capabilities `server/discover` advertises. */
  get capabilities(): ServerCapabilities {
    const live = this.#options.changes !== undefined;
    const caps: ServerCapabilities = {};
    if (this.#tools.size > 0) caps.tools = { listChanged: live };
    if (this.#prompts.size > 0) caps.prompts = { listChanged: live };
    if (this.#resources.size > 0 || this.#templates.size > 0) {
      caps.resources = { listChanged: live, subscribe: live };
    }
    const completes =
      [...this.#prompts.values()].some((p) => p.complete !== undefined) ||
      [...this.#templates.values()].some((t) =>
        t.definition.complete !== undefined
      );
    if (completes) caps.completions = {};
    if (this.#options.logging) caps.logging = {};
    const extensions = { ...this.#options.capabilities?.extensions };
    if (this.#options.tasks !== undefined) extensions[TASKS_EXTENSION] = {};
    if (Object.keys(extensions).length > 0) caps.extensions = extensions;
    const experimental = { ...this.#options.capabilities?.experimental };
    const idempotency = this.#options.idempotency;
    if (idempotency !== undefined) {
      experimental[IDEMPOTENCY_CAPABILITY] = {
        durable: idempotency.store.durable === true,
      };
    }
    if (
      this.#options.capabilities?.experimental !== undefined ||
      idempotency !== undefined
    ) {
      caps.experimental = experimental;
    }
    return caps;
  }

  /* Dispatch */

  /**
   * Checks a framed request, in this order: `_meta` (-32602), the
   * transport's header hook, the protocol version (-32022), the method
   * (-32601, also for features the server does not have), the params
   * (-32602), then the transport's params hook. Throws McpError.
   */
  prepare(request: JSONRPCRequest, hooks: PrepareHooks = {}): PreparedRequest {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const metaIssues = params._meta === undefined
      ? [{ path: ["params", "_meta"], message: "is required" }]
      : check(params._meta, requestMeta, ["params", "_meta"]);
    if (metaIssues.length > 0) {
      throw McpError.invalidParams(
        `Invalid request metadata: ${formatIssues(metaIssues)}`,
      );
    }
    const meta = params._meta as RequestMetaObject;
    hooks.afterMeta?.(meta);
    const version = meta[META.protocolVersion];
    if (!this.versions.includes(version)) {
      throw McpError.unsupportedVersion(this.versions, version);
    }
    const method = request.method;
    if (!isClientRequestMethod(method) || !this.#serves(method)) {
      throw McpError.methodNotFound(method);
    }
    const issues = check(params, REQUEST_PARAMS[method], ["params"]);
    if (issues.length > 0) {
      throw McpError.invalidParams(`Invalid params: ${formatIssues(issues)}`);
    }
    const prepared = { id: request.id, method, params, meta };
    hooks.afterParams?.(prepared);
    return prepared;
  }

  #serves(method: ClientRequestMethod): boolean {
    const caps = this.capabilities;
    switch (method) {
      case "tools/list":
      case "tools/call":
        return caps.tools !== undefined;
      case "prompts/list":
      case "prompts/get":
        return caps.prompts !== undefined;
      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
        return caps.resources !== undefined;
      case "completion/complete":
        return caps.completions !== undefined;
      case "tasks/get":
      case "tasks/update":
      case "tasks/cancel":
        return this.#options.tasks !== undefined;
      default:
        return true;
    }
  }

  /**
   * Runs a prepared request. Resolves to its response, or to null as soon
   * as the signal aborts (the client is gone, so nothing may be sent),
   * whether or not the handler cooperates. An abandoned handler keeps
   * running until it observes `ctx.signal` (a keyed `tools/call`, whose
   * signal never fires, to its end), counted against
   * `maxAbandonedRequests`; how it settles is logged at debug level and
   * dropped.
   *
   * Rejects, instead of answering, when the caller's credential lacks the
   * scopes a tool, task or sealed state needs: an `unauthorized` McpError
   * with status 403 and `data: { error: "insufficient_scope", scope }`
   * ({@link isScopeRefusal}), for the transport to answer as an
   * authorization failure. That refusal comes before any handler runs, so
   * a client may step up and send the request again. Any other McpError a
   * handler throws (an `unauthorized` one from an inner client included)
   * is answered as a failure: a JSON-RPC error of kind `rpc` as is,
   * anything else as -32603.
   */
  async execute(
    request: PreparedRequest,
    options: ExecuteOptions = {},
  ): Promise<JSONRPCResponse | null> {
    const signal = options.signal ?? new AbortController().signal;
    const meta = request.meta;
    const info: RequestInfo = {
      requestId: request.id,
      method: request.method,
      protocolVersion: meta[META.protocolVersion],
      clientCapabilities: meta[META.clientCapabilities],
      clientInfo: meta[META.clientInfo] ?? null,
      meta,
      principal: options.principal ?? null,
      signal,
    };
    let finished = false;
    const emit = (notification: JSONRPCNotification) => {
      if (finished || signal.aborted || options.emit === undefined) return;
      Promise.resolve(options.emit(notification)).catch(() => {});
    };
    try {
      const work = this.#run(request, info, emit, options);
      const result = await unlessAborted(
        work,
        signal,
        (outcome) => this.#late(info, outcome),
      );
      // Abandoned work goes on until it observes the signal (or, for a
      // keyed tools/call, to its end). It is counted against
      // `maxAbandonedRequests` until it settles, and not held with
      // `waitUntil`: nobody waits for an unkeyed answer, and a keyed one's
      // recording is held by #once.
      if (result === ABANDONED) {
        this.#abandoned++;
        work.then(() => {}, () => {}).then(() => this.#abandoned--);
      }
      if (result === ABANDONED || signal.aborted) return null;
      return { jsonrpc: "2.0", id: request.id, result: this.#decorate(result) };
    } catch (error) {
      if (signal.aborted) return null;
      if (isScopeRefusal(error)) throw error;
      let failure: McpError;
      if (error instanceof McpError && error.kind === "rpc") failure = error;
      else {
        this.#report(error, info);
        failure = McpError.internal();
      }
      return { jsonrpc: "2.0", id: request.id, error: failure.toRpcError() };
    } finally {
      finished = true;
    }
  }

  /** Prepares and executes in one step, as a transport without headers would. */
  async handle(
    request: JSONRPCRequest,
    options: ExecuteOptions = {},
  ): Promise<JSONRPCResponse | null> {
    let prepared: PreparedRequest;
    try {
      prepared = this.prepare(request);
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      return { jsonrpc: "2.0", id: request.id, error: error.toRpcError() };
    }
    return await this.execute(prepared, options);
  }

  /** Logs, at debug, how a request abandoned on abort settled. */
  #late(info: RequestInfo, outcome: LateOutcome): void {
    console.debug(
      `mcp: ${info.method} ${
        JSON.stringify(info.requestId)
      } finished after it was abandoned; its ${
        "error" in outcome ? "failure" : "result"
      } was dropped`,
      ...("error" in outcome ? [outcome.error] : []),
    );
  }

  #report(error: unknown, info: RequestInfo): void {
    if (this.#options.onError !== undefined) this.#options.onError(error, info);
    else console.error(`mcp: ${info.method} failed:`, error);
  }

  #decorate(result: Record<string, unknown>): Result {
    const meta = isPlainObject(result._meta) ? result._meta : {};
    return {
      ...result,
      resultType: typeof result.resultType === "string"
        ? result.resultType
        : "complete",
      _meta: { ...meta, [META.serverInfo]: this.info },
    };
  }

  #hints(
    own?: CacheHints,
  ): { ttlMs: number; cacheScope: "public" | "private" } {
    const defaults = this.#options.cache;
    const ttlMs = own?.ttlMs ?? defaults?.ttlMs ?? 60_000;
    // A handler's value is clamped: NaN is no caching, Infinity a day.
    return {
      ttlMs: Number.isNaN(ttlMs)
        ? 0
        : Math.min(Math.max(0, Math.floor(ttlMs)), MAX_CACHE_TTL_MS),
      cacheScope: own?.scope ?? defaults?.scope ?? "private",
    };
  }

  async #run(
    request: PreparedRequest,
    info: RequestInfo,
    emit: (notification: JSONRPCNotification) => void,
    options: ExecuteOptions,
  ): Promise<Record<string, unknown>> {
    const params = request.params;
    switch (request.method) {
      case "server/discover": {
        const result: Record<string, unknown> = {
          supportedVersions: [...this.versions],
          capabilities: this.capabilities,
          ...this.#hints(),
        };
        if (this.#options.instructions !== undefined) {
          result.instructions = this.#options.instructions;
        }
        return result;
      }
      case "tools/list":
        return this.#page(
          "tools",
          [...this.#tools.values()].filter((entry) =>
            entry.definition.visible?.(info) ?? true
          ).map((entry) => [entry.tool.name, entry.tool]),
          params.cursor as string | undefined,
        );
      case "prompts/list":
        return this.#page(
          "prompts",
          [...this.#prompts.values()].filter((p) => p.visible?.(info) ?? true)
            .map((p) => [p.name, this.#promptOf(p)]),
          params.cursor as string | undefined,
        );
      case "resources/list":
        return this.#page(
          "resources",
          [...this.#resources.values()].filter((r) => r.visible?.(info) ?? true)
            .map((r) => [r.uri, this.#resourceOf(r)]),
          params.cursor as string | undefined,
        );
      case "resources/templates/list":
        return this.#page(
          "resourceTemplates",
          [...this.#templates.values()].filter((t) =>
            t.definition.visible?.(info) ?? true
          ).map((t) => [t.definition.uriTemplate, this.#templateOf(t)]),
          params.cursor as string | undefined,
        );
      case "tools/call": {
        // Before the idempotency claim, so a refusal is never stored.
        this.#checkBusy();
        this.#checkScopes(this.requiredScopes(request), info, options);
        const opened = await this.#openState(request, info, options);
        const key = request.meta[IDEMPOTENCY_KEY];
        const keyed = this.#options.idempotency !== undefined &&
          key !== undefined;
        // A keyed call is not cancelled when its client leaves: the key
        // says the client will ask again for this answer, so the handler
        // runs to its end and the answer is recorded, instead of a
        // failure caused by the abort.
        const runInfo = keyed
          ? { ...info, signal: new AbortController().signal }
          : info;
        const call = () =>
          this.#withInput(
            request,
            runInfo,
            emit,
            opened,
            (ctx) => this.#callTool(params, ctx),
          );
        return keyed
          ? await this.#once(request, info, key, call, options)
          : await call();
      }
      case "prompts/get":
        this.#checkBusy();
        return await this.#withInput(
          request,
          info,
          emit,
          await this.#openState(request, info, options),
          (ctx) => this.#getPrompt(params, ctx),
        );
      case "resources/read":
        this.#checkBusy();
        return await this.#withInput(
          request,
          info,
          emit,
          await this.#openState(request, info, options),
          (ctx) => this.#readResource(params.uri as string, ctx),
        );
      case "completion/complete":
        return await this.#complete(
          params as unknown as CompleteRequestParams,
          info,
        );
      case "subscriptions/listen":
        return await this.#listen(request, info, options);
      case "tasks/get":
      case "tasks/update":
      case "tasks/cancel":
        return await this.#taskRequest(request, info, options);
    }
  }

  /**
   * Refuses a request that would run a handler while
   * `maxAbandonedRequests` handlers are still running for clients that
   * left, so a client cannot pile up work by leaving at once.
   */
  #checkBusy(): void {
    if (this.#abandoned < this.#maxAbandoned) return;
    throw McpError.rpc(
      INTERNAL_ERROR,
      "Too many requests are still running after their clients left; try again later",
      { busy: true },
    );
  }

  /** Throws {@link insufficientScope} unless the caller holds `required`. */
  #checkScopes(
    required: readonly string[],
    info: RequestInfo,
    options: ExecuteOptions,
  ): void {
    if (required.length === 0) return;
    const satisfied = options.scopeSatisfied ?? exactScope;
    const granted = info.principal?.scopes ?? [];
    const missing = required.filter((scope) => {
      const result = satisfied(granted, scope);
      if (typeof result !== "boolean") {
        throw new TypeError("scopeSatisfied must return boolean");
      }
      return result === false;
    });
    if (missing.length > 0) throw insufficientScope(required, missing);
  }

  /**
   * Runs a `tools/call` carrying an idempotency key at most once per
   * caller (its principal's `key`; anonymous callers share one namespace),
   * tool, key and round (`requestState`), and answers duplicates
   * from the store. The answer is recorded when the call settles, even if
   * the client has gone away by then, so its retry gets it.
   *
   * A task's token (`_meta["celld/task-token"]`, the only capability over
   * an anonymous task) is never stored in a slot: anyone repeating an
   * anonymous key would otherwise be handed it. A duplicate of a call
   * that started an anonymous task is refused (-32600) instead of
   * replayed; only the first answer carries the token. The same holds for
   * an anonymous `input_required` answer, whose sealed `requestState` is
   * the capability over the next round.
   *
   * The handler of a keyed call gets a signal that never aborts (see
   * `#run`), so a client that left finds the real answer when it asks
   * again; until then a duplicate gets `inProgress`. The answer is
   * recorded under the claim's token: a call that outlives its claim, and
   * finishes after a retry claimed the key again, records nothing.
   */
  async #once(
    request: PreparedRequest,
    info: RequestInfo,
    key: unknown,
    call: () => Promise<Record<string, unknown>>,
    options: ExecuteOptions,
  ): Promise<Record<string, unknown>> {
    if (!isIdempotencyKey(key)) {
      throw McpError.invalidParams(
        `Invalid ${IDEMPOTENCY_KEY}: 1-255 printable ASCII characters`,
      );
    }
    const store = this.#options.idempotency!.store;
    const { _meta: _, ...params } = request.params;
    const slot = await sha256(canonicalJson([
      "tools/call",
      info.principal === null ? null : principalOwner(info.principal),
      params.name,
      key,
      params.requestState ?? null,
    ]));
    const digest = await sha256(canonicalJson(params));
    const claim = await store.claim(slot, this.#idempotencyTtl);
    if (!claim.first) {
      const stored = claim.result;
      if (stored === undefined) {
        throw McpError.rpc(
          INVALID_REQUEST,
          "A request with this idempotency key is still running",
          { idempotencyKey: key, inProgress: true },
        );
      }
      if (!isPlainObject(stored) || stored.digest !== digest) {
        throw McpError.invalidParams(
          "The idempotency key was used with other arguments",
          { idempotencyKey: key },
        );
      }
      if (stored.anonymousState === true) {
        throw McpError.rpc(
          INVALID_REQUEST,
          "A request with this idempotency key already asked for input; only its first answer carries the requestState",
          { idempotencyKey: key },
        );
      }
      if (stored.anonymousTask === true) {
        throw McpError.rpc(
          INVALID_REQUEST,
          "A task was already started with this idempotency key; only its first answer carries the task's token",
          { idempotencyKey: key },
        );
      }
      if (isPlainObject(stored.error)) {
        const error = stored.error as {
          code: number;
          message: string;
          data?: JSONValue;
        };
        throw McpError.rpc(error.code, error.message, error.data);
      }
      return stored.result as Record<string, unknown>;
    }
    const running = call();
    const recorded = running.then(
      (result) => {
        // An anonymous caller's sealed state is its capability over the
        // next round: never handed to whoever repeats the key.
        if (
          info.principal === null && result.resultType === "input_required"
        ) {
          return store.complete(slot, claim.token, {
            digest,
            anonymousState: true,
          });
        }
        const meta = result._meta;
        if (isPlainObject(meta) && Object.hasOwn(meta, TASK_TOKEN)) {
          const { [TASK_TOKEN]: _token, ...rest } = meta;
          return store.complete(slot, claim.token, {
            digest,
            result: { ...result, _meta: rest },
            anonymousTask: true,
          });
        }
        return store.complete(slot, claim.token, { digest, result });
      },
      (error) =>
        store.complete(slot, claim.token, {
          digest,
          error: error instanceof McpError && error.kind === "rpc"
            ? error.toRpcError()
            : { code: INTERNAL_ERROR, message: "Internal error" },
        }),
    ).catch(async (error) => {
      // An answer the store cannot keep (too large for it): record a
      // failure instead, so the key is not left running until its TTL.
      this.#report(error, info);
      await store.complete(slot, claim.token, {
        digest,
        error: { code: INTERNAL_ERROR, message: "Internal error" },
      }).catch((again) => this.#report(again, info));
    });
    // The answer is recorded when the call settles, even after the client
    // has gone: held with waitUntil so the runtime lets it finish.
    options.waitUntil?.(recorded);
    return await running;
  }

  /**
   * `tasks/get`, `tasks/update` and `tasks/cancel`: only for the task's
   * owner, and only while the caller still holds the scopes the task's tool
   * needed (and still sees the tool).
   */
  async #taskRequest(
    request: PreparedRequest,
    info: RequestInfo,
    options: ExecuteOptions,
  ): Promise<Record<string, unknown>> {
    const store = this.#options.tasks!.store;
    this.#require(info, { extensions: { [TASKS_EXTENSION]: {} } });
    const taskId = request.params.taskId as string;
    const action = request.method === "tasks/get"
      ? "retrieve"
      : request.method === "tasks/update"
      ? "update"
      : "cancel";
    const owner = await this.#taskOwner(info, action);
    const record = await this.#ownedTask(taskId, owner, action, info, options);
    switch (request.method) {
      case "tasks/get":
        return detailedTaskOf(record) as unknown as Record<string, unknown>;
      case "tasks/update":
        await store.update(
          taskId,
          owner,
          request.params.inputResponses as InputResponses,
        );
        return {};
      default:
        await store.cancel(taskId, owner);
        return {};
    }
  }

  /**
   * Who a task follow-up acts as: the principal's key, or for an anonymous
   * caller the owner its task token stands for (-32602 without one).
   */
  async #taskOwner(info: RequestInfo, action: string): Promise<string> {
    if (info.principal !== null) return principalOwner(info.principal);
    const token = (info.meta as Record<string, unknown>)[TASK_TOKEN];
    if (token === undefined) {
      throw McpError.invalidParams(
        `Failed to ${action} task: anonymous task operations need the task's token in _meta["${TASK_TOKEN}"]`,
      );
    }
    if (!isTaskToken(token)) {
      throw McpError.invalidParams(`Invalid _meta["${TASK_TOKEN}"]`);
    }
    return await capabilityOwner(token);
  }

  /** The task `owner` owns, once the caller is shown to still be allowed it. */
  async #ownedTask(
    taskId: string,
    owner: string,
    action: string,
    info: RequestInfo,
    options: ExecuteOptions,
  ): Promise<TaskRecord> {
    const retrieve = "Failed to retrieve task";
    let record: TaskRecord;
    try {
      record = await this.#options.tasks!.store.get(taskId, owner);
    } catch (error) {
      if (
        error instanceof McpError && error.kind === "rpc" &&
        error.code !== null && error.message.startsWith(retrieve)
      ) {
        throw McpError.rpc(
          error.code,
          `Failed to ${action} task${error.message.slice(retrieve.length)}`,
          error.data ?? undefined,
        );
      }
      throw error;
    }
    if (!this.#mayFollow(record, info, options)) {
      throw McpError.invalidParams(`Failed to ${action} task: Task not found`);
    }
    return record;
  }

  /**
   * Whether the caller, who owns `record`, may still use it: false when the
   * task's tool is hidden from this request; throws
   * {@link insufficientScope} when the credential lacks the scopes stored
   * with the task or the tool's current ones.
   */
  #mayFollow(
    record: TaskRecord,
    info: RequestInfo,
    options: ExecuteOptions,
  ): boolean {
    const entry = this.#tools.get(record.name);
    if (entry !== undefined && !(entry.definition.visible?.(info) ?? true)) {
      return false;
    }
    if (!Array.isArray(record.scopes)) return false;
    this.#checkScopes(
      scopeUnion(record.scopes, entry?.definition.scopes ?? []),
      info,
      options,
    );
    return true;
  }

  #page(
    field: string,
    entries: [string, unknown][],
    cursor: string | undefined,
  ): Record<string, unknown> {
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let start = 0;
    if (cursor !== undefined) {
      const after = decodeCursor(cursor);
      start = entries.findIndex(([key]) => key > after);
      if (start === -1) start = entries.length;
    }
    const size = this.#options.pageSize ?? 100;
    const page = entries.slice(start, start + size);
    const result: Record<string, unknown> = {
      [field]: page.map(([, item]) => item),
      ...this.#hints(),
    };
    if (start + size < entries.length) {
      result.nextCursor = encodeCursor(page[page.length - 1][0]);
    }
    return result;
  }

  #promptOf(definition: PromptDefinition): Prompt {
    const prompt: Prompt = { name: definition.name };
    if (definition.title !== undefined) prompt.title = definition.title;
    if (definition.description !== undefined) {
      prompt.description = definition.description;
    }
    if (definition.arguments !== undefined) {
      prompt.arguments = definition.arguments;
    }
    if (definition.icons !== undefined) prompt.icons = definition.icons;
    if (definition._meta !== undefined) prompt._meta = definition._meta;
    return prompt;
  }

  #resourceOf(definition: ResourceDefinition): Resource {
    const resource: Resource = { uri: definition.uri, name: definition.name };
    for (
      const key of [
        "title",
        "description",
        "mimeType",
        "annotations",
        "size",
        "icons",
        "_meta",
      ] as const
    ) {
      if (definition[key] !== undefined) {
        (resource as unknown as Record<string, unknown>)[key] = definition[key];
      }
    }
    return resource;
  }

  #templateOf(entry: TemplateEntry): ResourceTemplate {
    const definition = entry.definition;
    const template: ResourceTemplate = {
      uriTemplate: definition.uriTemplate,
      name: definition.name,
    };
    for (
      const key of [
        "title",
        "description",
        "mimeType",
        "annotations",
        "icons",
        "_meta",
      ] as const
    ) {
      if (definition[key] !== undefined) {
        (template as unknown as Record<string, unknown>)[key] = definition[key];
      }
    }
    return template;
  }

  #require(info: RequestInfo, required: ClientCapabilities | undefined): void {
    if (required === undefined) return;
    const missing = missingCapabilities(info.clientCapabilities, required);
    if (missing !== null) throw McpError.missingCapability(missing);
  }

  /**
   * Opens a request's sealed state, if it has one, and checks it: this
   * request's method and params, the caller's principal key, the expiry
   * (-32602 for any of them), then the scopes it recorded against the
   * caller's current ones ({@link insufficientScope}). Merges the retry's
   * answers to the questions it asked.
   */
  async #openState(
    request: PreparedRequest,
    info: RequestInfo,
    options: ExecuteOptions,
  ): Promise<OpenedState> {
    const params = request.params;
    const digest = await paramsDigest(request.method, params);
    const principal = info.principal === null
      ? null
      : principalOwner(info.principal);
    const scopes = this.requiredScopes(request);
    if (params.requestState === undefined) {
      // Without a sealed state, `inputResponses` answer nothing that was
      // asked, so they are ignored.
      return { digest, principal, scopes, answers: {}, state: null };
    }
    if (this.#sealer === null) {
      throw McpError.invalidParams("Invalid requestState");
    }
    const opened = await this.#sealer.open(params.requestState as string);
    if (
      opened === null || opened.method !== request.method ||
      opened.digest !== digest || opened.principal !== principal ||
      opened.expiresAt <= this.#now()
    ) {
      throw McpError.invalidParams(
        opened !== null && opened.expiresAt <= this.#now()
          ? "Expired requestState"
          : "Invalid requestState",
      );
    }
    this.#checkScopes(opened.scopes, info, options);
    const answers: InputResponses = { ...opened.answers };
    const responses = (params.inputResponses ?? {}) as Record<
      string,
      unknown
    >;
    for (const [key, method] of Object.entries(opened.asked)) {
      if (!Object.hasOwn(responses, key)) continue;
      const issues = check(responses[key], INPUT_RESPONSE[method], [
        "params",
        "inputResponses",
        key,
      ]);
      if (issues.length > 0) {
        throw McpError.invalidParams(
          `Invalid input response: ${formatIssues(issues)}`,
        );
      }
      answers[key] = responses[key] as InputResponse;
    }
    return {
      digest,
      principal,
      scopes: scopeUnion(scopes, opened.scopes),
      answers,
      state: opened.state,
    };
  }

  /**
   * Runs an MRTR-capable handler with its opened state (see
   * {@link McpServer.#openState}), and turns `InputRequired` into an
   * `InputRequiredResult` with freshly sealed state.
   */
  async #withInput(
    request: PreparedRequest,
    info: RequestInfo,
    emit: (notification: JSONRPCNotification) => void,
    opened: OpenedState,
    handler: (ctx: HandlerContext) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const { digest, principal, answers, state } = opened;
    const ctx = this.#context(info, emit, { state, answers, mrtr: true });
    try {
      return await handler(ctx);
    } catch (error) {
      if (!(error instanceof InputRequired)) throw error;
      if (this.#sealer === null) {
        throw new Error(
          "a handler asked for input, but the server has no stateSecret",
        );
      }
      const requests: Record<string, string> = {};
      for (const [key, value] of Object.entries(error.requests)) {
        this.#require(info, capabilityFor(value));
        requests[key] = value.method;
      }
      const sealed = await this.#sealer.seal({
        method: request.method,
        digest,
        principal,
        scopes: opened.scopes,
        expiresAt: this.#now() + (this.#options.stateTtlMs ?? 600_000),
        asked: requests,
        answers,
        state: error.state,
      });
      const result: Record<string, unknown> = {
        resultType: "input_required",
        requestState: sealed,
      };
      if (Object.keys(error.requests).length > 0) {
        result.inputRequests = error.requests;
      }
      return result;
    }
  }

  #context(
    info: RequestInfo,
    emit: (notification: JSONRPCNotification) => void,
    input: {
      state: JSONValue | null;
      answers: InputResponses;
      mrtr: boolean;
    },
  ): HandlerContext {
    const meta = info.meta;
    const token = meta[META.progressToken] as ProgressToken | undefined;
    const threshold = meta[META.logLevel];
    let lastProgress = -Infinity;
    let state = input.state;
    const helpers = inputHelpers(info.clientCapabilities, input.answers, {
      get: () => state,
      set: (next) => {
        state = next;
      },
    }, (what) => {
      if (!input.mrtr) {
        throw new Error(
          `${what} is only available in tools/call, prompts/get and resources/read`,
        );
      }
    });
    const ctx: HandlerContext = {
      ...info,
      progress(progress, options = {}) {
        if (token === undefined || !(progress > lastProgress)) return;
        lastProgress = progress;
        const params: Record<string, unknown> = {
          progressToken: token,
          progress,
        };
        if (options.total !== undefined) params.total = options.total;
        if (options.message !== undefined) params.message = options.message;
        emit({ jsonrpc: "2.0", method: "notifications/progress", params });
      },
      log: (level, data, logger) => {
        if (
          !this.#options.logging || threshold === undefined ||
          !logLevelAtLeast(level, threshold)
        ) {
          return;
        }
        const params: Record<string, unknown> = { level, data };
        if (logger !== undefined) params.logger = logger;
        emit({ jsonrpc: "2.0", method: "notifications/message", params });
      },
      requireCapabilities: helpers.requireCapabilities,
      get state() {
        return state;
      },
      setState(next) {
        state = next;
      },
      input: helpers.input,
      elicit: helpers.elicit,
      sample: helpers.sample,
      roots: helpers.roots,
      ask: helpers.ask,
      inputRequired: helpers.inputRequired,
      task(options = {}) {
        if (info.method !== "tools/call") {
          throw new Error("ctx.task is only available in tools/call");
        }
        throw new TaskRequested(options);
      },
    };
    return ctx;
  }

  async #callTool(
    params: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<Record<string, unknown>> {
    const name = params.name as string;
    const entry = this.#tools.get(name);
    if (entry === undefined || !(entry.definition.visible?.(ctx) ?? true)) {
      throw McpError.invalidParams(`Unknown tool: ${name}`, { name });
    }
    this.#require(ctx, entry.definition.requires);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const checked = await entry.input.check(args);
    if (!checked.ok) {
      return {
        content: [{
          type: "text",
          text: `Invalid arguments for ${name}: ${
            formatIssues(checked.issues)
          }`,
        }],
        isError: true,
      };
    }
    let returned: ToolReturn;
    try {
      const run = entry.definition.run;
      if (run === undefined) throw new TaskRequested({});
      returned = await run(checked.value, ctx);
    } catch (error) {
      if (error instanceof TaskRequested) {
        return await this.#startTask(entry, args, ctx, error.options);
      }
      return this.#toolFailure(name, error, ctx);
    }
    return await this.#toolResult(entry, returned);
  }

  /**
   * A tool handler's failure as a tool result: a `ToolError` shows its
   * message, anything else a generic one (and goes to `onError`). Input
   * signals, JSON-RPC errors (kind `rpc`) and the server's own scope
   * refusal are rethrown, as is anything after the request was cancelled.
   * Any other McpError (an inner client's `unauthorized`, `http` or
   * `timeout`) is a generic failure: its text may be an upstream's, and an
   * `unauthorized` one must not become this server's step-up challenge.
   */
  #toolFailure(
    name: string,
    error: unknown,
    info: RequestInfo,
  ): Record<string, unknown> {
    if (error instanceof ToolError) {
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
    if (
      error instanceof InputRequired || isScopeRefusal(error) ||
      (error instanceof McpError && error.kind === "rpc")
    ) {
      throw error;
    }
    if (info.signal.aborted) throw error;
    this.#report(error, info);
    return {
      content: [{ type: "text", text: `Tool ${name} failed` }],
      isError: true,
    };
  }

  /**
   * A handler's return value as a `CallToolResult`, checked against the
   * protocol and the output schema (a sieve output schema's parsed value is
   * what is sent). A failed check is a server bug, thrown as a plain Error.
   */
  async #toolResult(
    entry: ToolEntry,
    returned: ToolReturn,
  ): Promise<Record<string, unknown>> {
    const name = entry.tool.name;
    const result: CallToolResult = typeof returned === "string"
      ? { resultType: "complete", content: [{ type: "text", text: returned }] }
      : {
        resultType: "complete",
        content: returned.content ??
          (returned.structuredContent !== undefined
            ? [{
              type: "text",
              text: JSON.stringify(returned.structuredContent),
            }]
            : []),
      };
    if (typeof returned !== "string") {
      if (returned.structuredContent !== undefined) {
        result.structuredContent = returned.structuredContent;
      }
      if (returned.isError !== undefined) result.isError = returned.isError;
      if (returned._meta !== undefined) result._meta = returned._meta;
    }
    const contentIssues = check(result.content, (value, path, out) => {
      if (!Array.isArray(value)) {
        out.push({ path, message: "content must be an array" });
      } else {value.forEach((item, index) =>
          contentBlock(item, [...path, index], out)
        );}
    }, ["content"]);
    if (contentIssues.length > 0) {
      throw new Error(`tool ${name} returned ${formatIssues(contentIssues)}`);
    }
    if (entry.output !== null && result.isError !== true) {
      if (result.structuredContent === undefined) {
        throw new Error(
          `tool ${name} has an outputSchema but returned no structuredContent`,
        );
      }
      const checked = await entry.output.check(result.structuredContent);
      if (!checked.ok) {
        throw new Error(
          `tool ${name} returned structuredContent that fails its outputSchema: ${
            formatIssues(checked.issues)
          }`,
        );
      }
      result.structuredContent = checked.value;
    }
    return result;
  }

  /** Stores a new task for a tool call and answers with its handle. */
  async #startTask(
    entry: ToolEntry,
    args: Record<string, unknown>,
    ctx: HandlerContext,
    options: StartTaskOptions,
  ): Promise<Record<string, unknown>> {
    const name = entry.tool.name;
    const definition = entry.definition.task;
    const tasks = this.#options.tasks;
    if (definition === undefined || tasks === undefined) {
      throw new Error(`tool ${name} called ctx.task() but has no task`);
    }
    // The spec: a request that can only be served as a task, from a client
    // without the extension, is -32021 naming it.
    this.#require(ctx, { extensions: { [TASKS_EXTENSION]: {} } });
    checkMs(options.ttlMs, "ttlMs", 1);
    checkMs(options.pollIntervalMs, "pollIntervalMs", 1);
    const now = this.#now();
    const ttlMs = options.ttlMs !== undefined
      ? options.ttlMs
      : definition.ttlMs !== undefined
      ? definition.ttlMs
      : tasks.ttlMs !== undefined
      ? tasks.ttlMs
      : 3_600_000;
    // An anonymous creator owns nothing: the task belongs to whoever holds
    // its token, which only this answer carries.
    const token = ctx.principal === null ? newTaskToken() : null;
    const owner = token === null
      ? principalOwner(ctx.principal!)
      : await capabilityOwner(token);
    const record: TaskRecord = {
      version: 2,
      taskId: newTaskId(),
      owner,
      scopes: [...(entry.definition.scopes ?? [])],
      principal: ctx.principal === null
        ? null
        : JSON.parse(JSON.stringify(ctx.principal)),
      method: "tools/call",
      name,
      arguments: args,
      protocolVersion: ctx.protocolVersion,
      clientCapabilities: ctx.clientCapabilities,
      clientInfo: ctx.clientInfo,
      status: "working",
      statusMessage: options.statusMessage ?? null,
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs,
      pollIntervalMs: options.pollIntervalMs ?? definition.pollIntervalMs ??
        tasks.pollIntervalMs ?? 1000,
      outstanding: {},
      asked: {},
      answers: {},
      state: options.state ?? null,
      result: null,
      error: null,
      runAt: now,
      runs: 0,
    };
    await tasks.store.create(record);
    const result: Record<string, unknown> = {
      ...taskOf(record),
      resultType: "task",
    };
    if (token !== null) result._meta = { [TASK_TOKEN]: token };
    return result;
  }

  /** Runs one round of a task body; see {@link TaskRunner}. */
  async #runTask(
    record: TaskRecord,
    hooks: TaskRunHooks,
  ): Promise<TaskOutcome> {
    const entry = this.#tools.get(record.name);
    const definition = entry?.definition.task;
    if (entry === undefined || definition === undefined) {
      return {
        type: "failed",
        error: {
          code: INVALID_PARAMS,
          message: `Unknown tool: ${record.name}`,
        },
      };
    }
    let state = record.state;
    const helpers = inputHelpers(record.clientCapabilities, record.answers, {
      get: () => state,
      set: (next) => {
        state = next;
      },
    }, () => {});
    const ctx: TaskContext = {
      taskId: record.taskId,
      name: record.name,
      principal: record.principal,
      protocolVersion: record.protocolVersion,
      clientCapabilities: record.clientCapabilities,
      clientInfo: record.clientInfo,
      signal: hooks.signal,
      run: record.runs,
      get state() {
        return state;
      },
      async save(next) {
        state = next;
        await hooks.save(next);
      },
      async status(message, options = {}) {
        checkMs(options.pollIntervalMs, "pollIntervalMs", 1);
        await hooks.status(message, options.pollIntervalMs);
      },
      requireCapabilities: helpers.requireCapabilities,
      input: helpers.input,
      elicit: helpers.elicit,
      sample: helpers.sample,
      roots: helpers.roots,
      ask: helpers.ask,
      inputRequired: helpers.inputRequired,
    };
    const info: RequestInfo = {
      requestId: record.taskId,
      method: "tools/call",
      protocolVersion: record.protocolVersion,
      clientCapabilities: record.clientCapabilities,
      clientInfo: record.clientInfo,
      meta: {} as RequestMetaObject,
      principal: record.principal,
      signal: hooks.signal,
    };
    // The record keeps the arguments as they were sent; each run parses them.
    const checked = await entry.input.check(record.arguments);
    if (!checked.ok) {
      return {
        type: "failed",
        error: {
          code: INVALID_PARAMS,
          message: `Invalid arguments for ${record.name}: ${
            formatIssues(checked.issues)
          }`,
        },
      };
    }
    let returned: ToolReturn;
    try {
      const outcome = await unlessAborted(
        Promise.resolve(definition.run(checked.value, ctx)),
        hooks.signal,
        (late) => this.#late(info, late),
      );
      if (outcome === ABANDONED) {
        return {
          type: "failed",
          error: { code: INTERNAL_ERROR, message: "The task was stopped" },
        };
      }
      returned = outcome;
    } catch (error) {
      if (error instanceof InputRequired) {
        return {
          type: "input_required",
          requests: error.requests,
          state: error.state,
        };
      }
      if (error instanceof McpError && error.kind === "rpc") {
        return { type: "failed", error: error.toRpcError() };
      }
      if (hooks.signal.aborted) {
        return {
          type: "failed",
          error: { code: INTERNAL_ERROR, message: "The task was stopped" },
        };
      }
      return {
        type: "completed",
        result: this.#toolFailure(record.name, error, info),
      };
    }
    try {
      return {
        type: "completed",
        result: await this.#toolResult(entry, returned),
      };
    } catch (error) {
      this.#report(error, info);
      return {
        type: "failed",
        error: { code: INTERNAL_ERROR, message: "Internal error" },
      };
    }
  }

  async #taskChanged(taskId: string): Promise<void> {
    const changes = this.#options.changes as
      | (ChangeSource & Partial<ChangePublisher>)
      | undefined;
    if (typeof changes?.publish !== "function") return;
    try {
      await changes.publish({ type: "task", taskId });
    } catch (error) {
      this.#report(error, {
        requestId: taskId,
        method: "tools/call",
        protocolVersion: LATEST_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: null,
        meta: {} as RequestMetaObject,
        principal: null,
        signal: new AbortController().signal,
      });
    }
  }

  async #getPrompt(
    params: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<Record<string, unknown>> {
    const name = params.name as string;
    const prompt = this.#prompts.get(name);
    if (prompt === undefined || !(prompt.visible?.(ctx) ?? true)) {
      throw McpError.invalidParams(`Unknown prompt: ${name}`, { name });
    }
    this.#require(ctx, prompt.requires);
    const args = (params.arguments ?? {}) as Record<string, string>;
    for (const argument of prompt.arguments ?? []) {
      if (argument.required && args[argument.name] === undefined) {
        throw McpError.invalidParams(
          `Missing required argument: ${argument.name}`,
          { name, argument: argument.name },
        );
      }
    }
    const returned = await prompt.get(args, ctx);
    const result: GetPromptResult = Array.isArray(returned)
      ? { resultType: "complete", messages: returned }
      : { resultType: "complete", ...returned };
    return result;
  }

  async #readResource(
    uri: string,
    ctx: HandlerContext,
  ): Promise<Record<string, unknown>> {
    const fixed = this.#resources.get(uri);
    if (fixed !== undefined && (fixed.visible?.(ctx) ?? true)) {
      this.#require(ctx, fixed.requires);
      return this.#contents(
        uri,
        fixed.mimeType,
        fixed.cache,
        await fixed.read(ctx),
      );
    }
    for (const entry of this.#templates.values()) {
      const match = entry.template.match(uri);
      if (match === null || !(entry.definition.visible?.(ctx) ?? true)) {
        continue;
      }
      const variables: Record<string, string> = {};
      try {
        entry.template.variables.forEach((name, index) => {
          variables[name] = decodeURIComponent(match[index]);
        });
      } catch {
        continue;
      }
      this.#require(ctx, entry.definition.requires);
      const returned = await entry.definition.read(uri, variables, ctx);
      if (returned === null) continue;
      return this.#contents(
        uri,
        entry.definition.mimeType,
        entry.definition.cache,
        returned,
      );
    }
    throw McpError.resourceNotFound(uri);
  }

  /**
   * Whether `uri` names a resource hidden from `info`'s caller: one this
   * server registered (fixed, or matching templates) whose `visible` says
   * no to it. A URI nothing registered names hides nothing (the server may
   * publish changes of dynamic resources under it).
   */
  #hidden(uri: string, info: RequestInfo): boolean {
    if (!this.#anyVisible()) return false;
    const fixed = this.#resources.get(uri);
    if (fixed !== undefined) return !(fixed.visible?.(info) ?? true);
    let known = false;
    for (const entry of this.#templates.values()) {
      if (!entry.template.test(uri)) continue;
      if (entry.definition.visible?.(info) ?? true) return false;
      known = true;
    }
    return known;
  }

  /** Whether any resource or template has a `visible` predicate. */
  #anyVisible(): boolean {
    for (const resource of this.#resources.values()) {
      if (resource.visible !== undefined) return true;
    }
    for (const entry of this.#templates.values()) {
      if (entry.definition.visible !== undefined) return true;
    }
    return false;
  }

  #contents(
    uri: string,
    mimeType: string | undefined,
    cache: CacheHints | undefined,
    returned: ResourceReturn,
  ): Record<string, unknown> {
    if (returned === null) throw McpError.resourceNotFound(uri);
    let contents: (TextResourceContents | BlobResourceContents)[];
    let hints = this.#hints(cache);
    if (typeof returned === "string") {
      contents = [{ uri, text: returned }];
    } else if (returned instanceof Uint8Array) {
      contents = [{ uri, blob: toBase64(returned) }];
    } else if (Array.isArray(returned)) {
      contents = returned;
    } else {
      contents = returned.contents;
      hints = this.#hints({
        ttlMs: returned.ttlMs ?? cache?.ttlMs,
        scope: returned.cacheScope ?? cache?.scope,
      });
    }
    if (mimeType !== undefined) {
      contents = contents.map((item) =>
        item.mimeType === undefined ? { ...item, mimeType } : item
      );
    }
    return { contents, ...hints };
  }

  async #complete(
    params: CompleteRequestParams,
    info: RequestInfo,
  ): Promise<Record<string, unknown>> {
    let completer: Completer | undefined;
    const ref = params.ref;
    if (ref.type === "ref/prompt") {
      const prompt = this.#prompts.get(ref.name);
      if (prompt === undefined || !(prompt.visible?.(info) ?? true)) {
        throw McpError.invalidParams(`Unknown prompt: ${ref.name}`);
      }
      completer = ownEntry(prompt.complete, params.argument.name);
    } else {
      const entry = this.#templates.get(ref.uri);
      if (entry === undefined || !(entry.definition.visible?.(info) ?? true)) {
        throw McpError.invalidParams(`Unknown resource template: ${ref.uri}`);
      }
      completer = ownEntry(entry.definition.complete, params.argument.name);
    }
    const found = completer === undefined ? [] : await completer(
      params.argument.value,
      { arguments: params.context?.arguments ?? {} },
      info,
    );
    const values = Array.isArray(found) ? found : found.values;
    const completion: Record<string, unknown> = {
      values: values.slice(0, 100),
    };
    const total = Array.isArray(found) ? values.length : found.total;
    if (total !== undefined) completion.total = total;
    const hasMore = Array.isArray(found)
      ? values.length > 100
      : found.hasMore ?? values.length > 100;
    if (hasMore) completion.hasMore = true;
    return { completion };
  }

  async #listen(
    request: PreparedRequest,
    info: RequestInfo,
    options: ExecuteOptions,
  ): Promise<Record<string, unknown>> {
    const requested = request.params.notifications as SubscriptionFilter;
    let total = 0;
    for (const uri of requested.resourceSubscriptions ?? []) {
      total += uri.length;
    }
    if (total > MAX_LISTEN_URI_TOTAL) {
      throw McpError.invalidParams(
        `resourceSubscriptions name more than ${MAX_LISTEN_URI_TOTAL} characters of URI`,
      );
    }
    const caps = this.capabilities;
    const honored: SubscriptionFilter = {};
    if (requested.toolsListChanged && caps.tools?.listChanged) {
      honored.toolsListChanged = true;
    }
    if (requested.promptsListChanged && caps.prompts?.listChanged) {
      honored.promptsListChanged = true;
    }
    if (requested.resourcesListChanged && caps.resources?.listChanged) {
      honored.resourcesListChanged = true;
    }
    if (
      requested.resourceSubscriptions !== undefined &&
      caps.resources?.subscribe
    ) {
      // Not resources hidden from this caller: a subscription must not
      // tell it when a resource it cannot see changes.
      honored.resourceSubscriptions = [
        ...new Set(requested.resourceSubscriptions),
      ].filter((uri) => !this.#hidden(uri, info));
    }
    const source = this.#options.changes;
    const tasks = this.#options.tasks;
    const owners = new Map<string, string>();
    if (requested.taskIds !== undefined) {
      // The tasks extension: asking for task notifications without it is -32021.
      this.#require(info, { extensions: { [TASKS_EXTENSION]: {} } });
      const tokens = info.principal === null ? listenTokens(info.meta) : null;
      if (tasks !== undefined && source !== undefined) {
        // Only the caller's own, live tasks; others are silently left out.
        // A task the caller owns but may no longer use for want of scopes
        // refuses the whole stream, so the client can step up.
        const own: string[] = [];
        for (const taskId of new Set(requested.taskIds)) {
          let owner: string;
          if (info.principal !== null) owner = principalOwner(info.principal);
          else {
            const token = tokens!.get(taskId);
            if (token === undefined) continue;
            owner = await capabilityOwner(token);
          }
          let record: TaskRecord;
          try {
            record = await tasks.store.get(taskId, owner);
          } catch (error) {
            if (!(error instanceof McpError)) throw error;
            continue;
          }
          if (!this.#mayFollow(record, info, options)) continue;
          owners.set(taskId, owner);
          own.push(taskId);
        }
        if (own.length > 0) honored.taskIds = own;
      }
    }
    const id = request.id;
    const tagged = (method: string, params: Record<string, unknown> = {}) => ({
      jsonrpc: "2.0" as const,
      method,
      params: { ...params, _meta: { [META.subscriptionId]: id } },
    });
    const send = async (notification: JSONRPCNotification) => {
      if (!info.signal.aborted) await options.emit?.(notification);
    };
    const sendTask = async (taskId: string) => {
      const owner = owners.get(taskId);
      if (owner === undefined) return;
      let record: TaskRecord;
      try {
        record = await tasks!.store.get(taskId, owner);
      } catch (error) {
        if (error instanceof McpError) return; // Expired meanwhile.
        throw error;
      }
      await send(
        tagged(
          "notifications/tasks",
          detailedTaskOf(record) as unknown as Record<string, unknown>,
        ),
      );
    };
    const graceful = { _meta: { [META.subscriptionId]: id } };
    const watching = Object.keys(honored).length > 0 && source !== undefined;

    // A lifetime (or the client leaving) stops the source.
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    info.signal.addEventListener("abort", onAbort, { once: true });
    // The stream was authorized once, at open: it ends no later than the
    // credential it was opened with.
    const bounds: number[] = [];
    bounds.push(
      this.#options.listenLifetimeMs ?? DEFAULT_LISTEN_LIFETIME_MS,
    );
    const expiresAt = info.principal?.expiresAt;
    if (expiresAt !== undefined) {
      bounds.push(Math.max(0, expiresAt - this.#now()));
    }
    const until = bounds.length === 0
      ? undefined
      : Math.min(...bounds, MAX_TIMER_MS);
    const timer = watching && until !== undefined
      ? setTimeout(() => stop.abort(), until)
      : undefined;
    try {
      // Attach before acknowledging, so no change after the ack is missed.
      const events = watching ? await source.listen(stop.signal) : null;
      await send(tagged("notifications/subscriptions/acknowledged", {
        notifications: honored,
      }));
      if (events === null) return graceful;
      // Each watched task's current state first, so a change made before
      // the subscription is not missed.
      for (const taskId of honored.taskIds ?? []) await sendTask(taskId);
      const iterator = events[Symbol.asyncIterator]();
      const stopped = abortedPromise(stop.signal);
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), stopped]);
          if (next === undefined || next.done) break;
          const event = next.value;
          for (const notification of expand(event, honored)) {
            await send(tagged(notification.method, notification.params));
          }
          if (
            event.type === "task" && honored.taskIds?.includes(event.taskId)
          ) {
            await sendTask(event.taskId);
          } else if (event.type === "reset") {
            for (const taskId of honored.taskIds ?? []) await sendTask(taskId);
          }
        }
      } finally {
        void iterator.return?.();
      }
      return graceful;
    } finally {
      clearTimeout(timer);
      info.signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * The task tokens an anonymous listen request carries
 * (`_meta["celld/task-tokens"]`: task id to token); -32602 when malformed.
 */
function listenTokens(meta: RequestMetaObject): Map<string, string> {
  const value = (meta as Record<string, unknown>)[TASK_TOKENS];
  const tokens = new Map<string, string>();
  if (value === undefined) return tokens;
  if (!isPlainObject(value)) {
    throw McpError.invalidParams(
      `Invalid _meta["${TASK_TOKENS}"]: an object from task id to token`,
    );
  }
  for (const [taskId, token] of Object.entries(value)) {
    if (!isTaskToken(token)) {
      throw McpError.invalidParams(
        `Invalid _meta["${TASK_TOKENS}"]: the token for ${
          JSON.stringify(taskId)
        } is malformed`,
      );
    }
    tokens.set(taskId, token);
  }
  return tokens;
}

function answerMatches(method: string, answer: InputResponse): boolean {
  const shape = INPUT_RESPONSE[method];
  return shape !== undefined && check(answer, shape).length === 0;
}

/** The input-asking half of a handler or task context. */
interface InputHelpers {
  requireCapabilities(required: ClientCapabilities): void;
  input(key: string): InputResponse | undefined;
  elicit(key: string, params: ElicitRequestParams): ElicitResult;
  sample(key: string, params: CreateMessageRequestParams): CreateMessageResult;
  roots(key: string): ListRootsResult;
  ask(requests: InputRequests): InputResponses;
  inputRequired(
    options?: { readonly requests?: InputRequests; readonly state?: JSONValue },
  ): never;
}

/**
 * Input helpers over the answers delivered so far: each returns its answer
 * when there is one, and otherwise throws `InputRequired` for the missing
 * requests, carrying the current state. `guard` runs first in each.
 */
function inputHelpers(
  capabilities: ClientCapabilities,
  answers: InputResponses,
  state: { get(): JSONValue | null; set(value: JSONValue | null): void },
  guard: (what: string) => void,
): InputHelpers {
  const require = (required: ClientCapabilities) => {
    const missing = missingCapabilities(capabilities, required);
    if (missing !== null) throw McpError.missingCapability(missing);
  };
  const answered = (key: string, request: InputRequest) => {
    const answer = answers[key];
    if (answer === undefined || !answerMatches(request.method, answer)) {
      return undefined;
    }
    // A submitted form must match the schema it was asked with.
    if (
      request.method === "elicitation/create" &&
      request.params.mode !== "url" &&
      (answer as ElicitResult).action === "accept"
    ) {
      // The handler's own schema (trusted); the answer is the client's.
      const issues = compileSchema(request.params.requestedSchema, {
        trustPatterns: true,
      }).validate(
        (answer as ElicitResult).content ?? {},
      );
      if (issues.length > 0) {
        throw McpError.invalidParams(
          `Input response ${key} does not match the requested schema: ${
            formatIssues(issues)
          }`,
        );
      }
    }
    return answer;
  };
  const one = (what: string, key: string, request: InputRequest) => {
    guard(what);
    require(capabilityFor(request));
    const answer = answered(key, request);
    if (answer !== undefined) return answer;
    throw new InputRequired({ [key]: request }, state.get());
  };
  return {
    requireCapabilities: require,
    input: (key) => answers[key],
    elicit: (key, params) =>
      one("elicit", key, {
        method: "elicitation/create",
        params,
      }) as ElicitResult,
    sample: (key, params) =>
      one("sample", key, {
        method: "sampling/createMessage",
        params,
      }) as CreateMessageResult,
    roots: (key) => one("roots", key, rootsRequest()) as ListRootsResult,
    ask(requests) {
      guard("ask");
      const missing: InputRequests = {};
      const out: InputResponses = {};
      for (const [key, request] of Object.entries(requests)) {
        require(capabilityFor(request));
        const answer = answered(key, request);
        if (answer === undefined) missing[key] = request;
        else out[key] = answer;
      }
      if (Object.keys(missing).length > 0) {
        throw new InputRequired(missing, state.get());
      }
      return out;
    },
    inputRequired(options = {}) {
      guard("inputRequired");
      for (const request of Object.values(options.requests ?? {})) {
        require(capabilityFor(request));
      }
      if (options.state !== undefined) state.set(options.state);
      throw new InputRequired(options.requests ?? {}, state.get());
    },
  };
}

/** The notifications a change becomes for a subscriber's filter. */
export function expand(
  event: ChangeEvent,
  filter: SubscriptionFilter,
): { method: string; params?: Record<string, unknown> }[] {
  const out: { method: string; params?: Record<string, unknown> }[] = [];
  const all = event.type === "reset";
  if ((all || event.type === "tools") && filter.toolsListChanged) {
    out.push({ method: "notifications/tools/list_changed" });
  }
  if ((all || event.type === "prompts") && filter.promptsListChanged) {
    out.push({ method: "notifications/prompts/list_changed" });
  }
  if ((all || event.type === "resources") && filter.resourcesListChanged) {
    out.push({ method: "notifications/resources/list_changed" });
  }
  const uris = filter.resourceSubscriptions ?? [];
  if (all) {
    for (const uri of uris) {
      out.push({ method: "notifications/resources/updated", params: { uri } });
    }
  } else if (event.type === "resource" && uris.includes(event.uri)) {
    out.push({
      method: "notifications/resources/updated",
      params: { uri: event.uri },
    });
  }
  return out;
}
