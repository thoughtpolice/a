// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0 AND MIT

/**
 * The Model Context Protocol 2026-07-28 message types, ported from the
 * normative schema (`schema/2026-07-28/schema.ts` in
 * github.com/modelcontextprotocol/modelcontextprotocol, MIT/Apache-2.0). The
 * definitions and most doc comments are upstream's; the `@example` pointers
 * into upstream's example tree are dropped, and a few internal helper types
 * are exported so the server and client can name them.
 *
 * Types only: the runtime checks for these shapes live in `validate.ts`.
 *
 * Upstream is mid-transition from MIT to Apache-2.0: new specification work
 * is Apache-2.0, and contributions not yet relicensed remain under this MIT
 * notice, reproduced as its terms require:
 *
 * > Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects,
 * > LLC.
 * >
 * > Permission is hereby granted, free of charge, to any person obtaining a
 * > copy of this software and associated documentation files (the
 * > "Software"), to deal in the Software without restriction, including
 * > without limitation the rights to use, copy, modify, merge, publish,
 * > distribute, sublicense, and/or sell copies of the Software, and to
 * > permit persons to whom the Software is furnished to do so, subject to
 * > the following conditions:
 * >
 * > The above copyright notice and this permission notice shall be included
 * > in all copies or substantial portions of the Software.
 * >
 * > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * > OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * > MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * > IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * > CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * > TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * > SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * @module
 */

import type { TaskStatusNotification } from "./tasks.ts";

/* JSON types */

/** Any JSON value. */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONObject
  | JSONArray;

/** A JSON object. */
export type JSONObject = { [key: string]: JSONValue };

/** A JSON array. */
export type JSONArray = JSONValue[];

/* JSON-RPC types */

/** Any valid JSON-RPC object that can be decoded off the wire, or encoded to be sent. */
export type JSONRPCMessage =
  | JSONRPCRequest
  | JSONRPCNotification
  | JSONRPCResponse;

/** The protocol revision this library implements. */
export const LATEST_PROTOCOL_VERSION = "2026-07-28";
/** The JSON-RPC version every message carries. */
export const JSONRPC_VERSION = "2.0";

/**
 * The contents of a `_meta` field. Keys have an optional reverse-DNS prefix
 * ending in `/` and a name; prefixes whose second label is
 * `modelcontextprotocol` or `mcp` are reserved for MCP. See `meta.ts` for
 * the key syntax check.
 */
export type MetaObject = Record<string, unknown>;

/** Request `_meta`, with the per-request protocol fields. */
export interface RequestMetaObject extends MetaObject {
  /**
   * If specified, the caller is requesting out-of-band progress notifications
   * for this request. The receiver is not obligated to provide them.
   */
  progressToken?: ProgressToken;
  /**
   * The MCP Protocol Version being used for this request. Required. For the
   * HTTP transport, this value MUST match the `MCP-Protocol-Version` header.
   */
  "io.modelcontextprotocol/protocolVersion": string;
  /**
   * Identifies the client software making the request. Self-reported and not
   * verified; for display, logging and debugging only.
   */
  "io.modelcontextprotocol/clientInfo"?: Implementation;
  /**
   * The client's capabilities for this specific request. Required. Servers
   * MUST NOT infer capabilities from prior requests.
   */
  "io.modelcontextprotocol/clientCapabilities": ClientCapabilities;
  /**
   * The desired log level for this request. If absent, the server MUST NOT
   * send any `notifications/message` for this request.
   *
   * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
   */
  "io.modelcontextprotocol/logLevel"?: LoggingLevel;
}

/** Notification `_meta`. */
export interface NotificationMetaObject extends MetaObject {
  /**
   * The JSON-RPC ID of the `subscriptions/listen` request whose stream
   * delivered this notification. Absent on request-scoped notifications.
   */
  "io.modelcontextprotocol/subscriptionId"?: RequestId;
}

/** Result `_meta`. */
export interface ResultMetaObject extends MetaObject {
  /** Identifies the server software producing the response. Self-reported. */
  "io.modelcontextprotocol/serverInfo"?: Implementation;
}

/** A progress token, used to associate progress notifications with the original request. */
export type ProgressToken = string | number;

/** An opaque token used to represent a cursor for pagination. */
export type Cursor = string;

/** Common params for any request. */
export interface RequestParams {
  _meta: RequestMetaObject;
}

/** A request, before JSON-RPC framing. */
export interface Request {
  method: string;
  // deno-lint-ignore no-explicit-any
  params?: { [key: string]: any };
}

/** Common params for any notification. */
export interface NotificationParams {
  _meta?: NotificationMetaObject;
}

/** A notification, before JSON-RPC framing. */
export interface Notification {
  method: string;
  // deno-lint-ignore no-explicit-any
  params?: { [key: string]: any };
}

/**
 * The type of a {@link Result}: `complete` for a final result,
 * `input_required` for an {@link InputRequiredResult}. Extensions may add
 * values; a client MUST treat a value it does not recognise as invalid.
 */
export type ResultType = "complete" | "input_required" | string;

/** Common result fields. */
export interface Result {
  _meta?: ResultMetaObject;
  /**
   * Servers implementing this protocol version MUST include this field. A
   * client MUST treat an absent field (an earlier-protocol server) as
   * `"complete"`.
   */
  resultType: ResultType;
  [key: string]: unknown;
}

/** A JSON-RPC error object. */
export interface Error {
  /** The error type that occurred. */
  code: number;
  /** A short description of the error, SHOULD be a concise single sentence. */
  message: string;
  /** Additional information about the error, defined by the sender. */
  data?: unknown;
}

/** A uniquely identifying ID for a request in JSON-RPC. */
export type RequestId = string | number;

/** A request that expects a response. */
export interface JSONRPCRequest extends Request {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
}

/** A notification which does not expect a response. */
export interface JSONRPCNotification extends Notification {
  jsonrpc: typeof JSONRPC_VERSION;
}

/** A successful (non-error) response to a request. */
export interface JSONRPCResultResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: Result;
}

/** A response to a request that indicates an error occurred. */
export interface JSONRPCErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id?: RequestId;
  error: Error;
}

/** A response to a request, containing either the result or error. */
export type JSONRPCResponse = JSONRPCResultResponse | JSONRPCErrorResponse;

/** Invalid JSON was received. */
export const PARSE_ERROR = -32700;
/** The JSON is not a valid request object. */
export const INVALID_REQUEST = -32600;
/**
 * The method does not exist, or is gated behind a server capability the
 * server did not advertise.
 */
export const METHOD_NOT_FOUND = -32601;
/**
 * Invalid method parameters: unknown tool or prompt, invalid cursor, invalid
 * log level, a resource that does not exist (since 2026-07-28; formerly
 * -32002), a malformed `_meta`.
 */
export const INVALID_PARAMS = -32602;
/** Internal error. */
export const INTERNAL_ERROR = -32603;

/**
 * The HTTP headers of a request do not match the corresponding values in the
 * request body, or required headers are missing or malformed. HTTP 400.
 */
export const HEADER_MISMATCH = -32020;
/**
 * A server requires a client capability that was not declared in the
 * request's `clientCapabilities`. HTTP 400.
 */
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
/** The request's protocol version is not supported by the server. HTTP 400. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/**
 * Resource not found in 2025-11-25 and earlier. Implementations of this
 * version MUST NOT emit it; clients SHOULD still accept it.
 */
export const LEGACY_RESOURCE_NOT_FOUND = -32002;

/** `data` of an `UnsupportedProtocolVersionError`. */
export interface UnsupportedProtocolVersionData {
  /** Protocol versions the server supports. */
  supported: string[];
  /** The protocol version that was requested by the client. */
  requested: string;
}

/** `data` of a `MissingRequiredClientCapabilityError`. */
export interface MissingRequiredClientCapabilityData {
  /** The capabilities the server requires from the client to process this request. */
  requiredCapabilities: ClientCapabilities;
}

/** A result that indicates success but carries no data. */
export type EmptyResult = Result;

/** A server-to-client request carried in an {@link InputRequiredResult}. */
export type InputRequest =
  | CreateMessageRequest
  | ListRootsRequest
  | ElicitRequest;

/** A client's answer to an {@link InputRequest}. */
export type InputResponse =
  | CreateMessageResult
  | ListRootsResult
  | ElicitResult;

/** Server-initiated requests the client must fulfil, keyed by server-assigned ids. */
export interface InputRequests {
  [key: string]: InputRequest;
}

/** The client's results for {@link InputRequests}, under the same keys. */
export interface InputResponses {
  [key: string]: InputResponse;
}

/**
 * Sent by the server to indicate that additional input is needed before the
 * request can be completed. At least one of `inputRequests` or
 * `requestState` MUST be present.
 */
export interface InputRequiredResult extends Result {
  /** Requests the client must complete before retrying the original request. */
  inputRequests?: InputRequests;
  /**
   * State to pass back unchanged on the retry. Opaque to the client: it MUST
   * NOT inspect, parse or modify it.
   */
  requestState?: string;
}

/** Request params that carry the answers of a retry. */
export interface InputResponseRequestParams extends RequestParams {
  /** For each key in the previous `inputRequests`, the client's result. */
  inputResponses?: InputResponses;
  /** The previous result's `requestState`, echoed exactly. */
  requestState?: string;
}

/* Cancellation */

/** Parameters for a `notifications/cancelled` notification. */
export interface CancelledNotificationParams extends NotificationParams {
  /** The ID of the request to cancel. */
  requestId: RequestId;
  /** An optional reason, which MAY be logged or presented to the user. */
  reason?: string;
}

/**
 * Cancels a request on stdio. On Streamable HTTP, closing the response stream
 * is the cancellation signal instead.
 */
export interface CancelledNotification extends JSONRPCNotification {
  method: "notifications/cancelled";
  params: CancelledNotificationParams;
}

/* Discovery */

/** Asks the server for its supported versions, capabilities and identity. */
export interface DiscoverRequest extends JSONRPCRequest {
  method: "server/discover";
  params: RequestParams;
}

/** The result of `server/discover`. */
export interface DiscoverResult extends CacheableResult {
  /** Protocol versions this server supports. */
  supportedVersions: string[];
  /** The capabilities of the server. */
  capabilities: ServerCapabilities;
  /** Natural-language guidance for LLMs on how to use this server. */
  instructions?: string;
}

/** Capabilities a client may support. Not a closed set. */
export interface ClientCapabilities {
  /** Experimental, non-standard capabilities that the client supports. */
  experimental?: { [key: string]: JSONObject };
  /**
   * Present if the client supports listing roots.
   *
   * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
   */
  // deno-lint-ignore ban-types
  roots?: {};
  /**
   * Present if the client supports sampling from an LLM.
   *
   * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
   */
  sampling?: {
    /** Whether the client supports context inclusion via `includeContext`. */
    context?: JSONObject;
    /** Whether the client supports tool use via `tools` and `toolChoice`. */
    tools?: JSONObject;
  };
  /**
   * Present if the client supports elicitation. An empty object means form
   * mode only.
   */
  elicitation?: {
    form?: JSONObject;
    url?: JSONObject;
  };
  /** Extensions the client supports, keyed by prefixed identifier. */
  extensions?: { [key: string]: JSONObject };
}

/** Capabilities that a server may support. Not a closed set. */
export interface ServerCapabilities {
  /** Experimental, non-standard capabilities that the server supports. */
  experimental?: { [key: string]: JSONObject };
  /**
   * Present if the server supports sending log messages to the client.
   *
   * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
   */
  logging?: JSONObject;
  /** Present if the server supports argument autocompletion suggestions. */
  completions?: JSONObject;
  /** Present if the server offers any prompt templates. */
  prompts?: {
    /** Whether this server supports notifications for changes to the prompt list. */
    listChanged?: boolean;
  };
  /** Present if the server offers any resources to read. */
  resources?: {
    /** Whether this server supports subscribing to resource updates. */
    subscribe?: boolean;
    /** Whether this server supports notifications for changes to the resource list. */
    listChanged?: boolean;
  };
  /** Present if the server offers any tools to call. */
  tools?: {
    /** Whether this server supports notifications for changes to the tool list. */
    listChanged?: boolean;
  };
  /** Extensions the server supports, keyed by prefixed identifier. */
  extensions?: { [key: string]: JSONObject };
}

/** An optionally-sized icon that can be displayed in a user interface. */
export interface Icon {
  /** An HTTP/HTTPS URL or a `data:` URI with Base64-encoded image data. */
  src: string;
  /** Optional MIME type override if the source MIME type is missing or generic. */
  mimeType?: string;
  /** Sizes such as `"48x48"`, or `"any"` for scalable formats. */
  sizes?: string[];
  /** The background the icon is designed for. */
  theme?: "light" | "dark";
}

/** Base interface to add `icons` property. */
export interface Icons {
  /** Optional set of sized icons that the client can display in a user interface. */
  icons?: Icon[];
}

/** Base interface for metadata with name (identifier) and title (display name). */
export interface BaseMetadata {
  /** Intended for programmatic or logical use. */
  name: string;
  /** Intended for UI and end-user contexts. */
  title?: string;
}

/** Describes an MCP implementation. */
export interface Implementation extends BaseMetadata, Icons {
  /** The version of this implementation. */
  version: string;
  /** An optional human-readable description of what this implementation does. */
  description?: string;
  /** An optional URL of the website for this implementation. */
  websiteUrl?: string;
}

/* Progress notifications */

/** Parameters for a `notifications/progress` notification. */
export interface ProgressNotificationParams extends NotificationParams {
  /** The progress token which was given in the initial request. */
  progressToken: ProgressToken;
  /** The progress thus far. MUST increase with each notification. */
  progress: number;
  /** Total number of items to process, if known. */
  total?: number;
  /** An optional message describing the current progress. */
  message?: string;
}

/** A progress update for a long-running request. */
export interface ProgressNotification extends JSONRPCNotification {
  method: "notifications/progress";
  params: ProgressNotificationParams;
}

/* Pagination */

/** Common params for paginated requests. */
export interface PaginatedRequestParams extends RequestParams {
  /** An opaque pagination position; results start after it. */
  cursor?: Cursor;
}

/** A paginated result. */
export interface PaginatedResult extends Result {
  /** Present if there may be more results. */
  nextCursor?: Cursor;
}

/**
 * A result with caching hints. Servers MUST include them on complete results
 * of `server/discover`, the four list methods and `resources/read`.
 */
export interface CacheableResult extends Result {
  /**
   * How long, in milliseconds, the client MAY consider the result fresh,
   * like HTTP `max-age`. 0 means immediately stale. MUST be >= 0.
   */
  ttlMs: number;
  /**
   * `"public"`: no user-specific data; any cache may share it. `"private"`:
   * reusable only within the same authorization context.
   */
  cacheScope: "public" | "private";
}

/* Resources */

/** The result of `resources/list`. */
export interface ListResourcesResult extends PaginatedResult, CacheableResult {
  resources: Resource[];
}

/** The result of `resources/templates/list`. */
export interface ListResourceTemplatesResult
  extends PaginatedResult, CacheableResult {
  resourceTemplates: ResourceTemplate[];
}

/** Parameters for a `resources/read` request. */
export interface ReadResourceRequestParams extends InputResponseRequestParams {
  /** The URI of the resource. */
  uri: string;
}

/** The result of `resources/read`. */
export interface ReadResourceResult extends CacheableResult {
  contents: (TextResourceContents | BlobResourceContents)[];
}

/** The notification types a client may opt in to on `subscriptions/listen`. */
export interface SubscriptionFilter {
  /** If true, receive `notifications/tools/list_changed`. */
  toolsListChanged?: boolean;
  /** If true, receive `notifications/prompts/list_changed`. */
  promptsListChanged?: boolean;
  /** If true, receive `notifications/resources/list_changed`. */
  resourcesListChanged?: boolean;
  /** Receive `notifications/resources/updated` for these resource URIs. */
  resourceSubscriptions?: string[];
  /**
   * Receive `notifications/tasks` for these task ids. Added by the tasks
   * extension (`io.modelcontextprotocol/tasks`), not the core schema.
   */
  taskIds?: string[];
}

/** Parameters for a `subscriptions/listen` request. */
export interface SubscriptionsListenRequestParams extends RequestParams {
  /** The notifications the client opts in to on this stream. */
  notifications: SubscriptionFilter;
}

/**
 * The response to `subscriptions/listen`, sent only when the server ends the
 * subscription gracefully.
 */
export interface SubscriptionsListenResult extends Result {
  _meta: ResultMetaObject & {
    "io.modelcontextprotocol/subscriptionId": RequestId;
  };
}

/** Parameters for `notifications/subscriptions/acknowledged`. */
export interface SubscriptionsAcknowledgedNotificationParams
  extends NotificationParams {
  /** The subset of requested notification types the server agreed to honour. */
  notifications: SubscriptionFilter;
}

/** Acknowledges a subscription; always its first message. */
export interface SubscriptionsAcknowledgedNotification
  extends JSONRPCNotification {
  method: "notifications/subscriptions/acknowledged";
  params: SubscriptionsAcknowledgedNotificationParams;
}

/** Parameters for `notifications/resources/updated`. */
export interface ResourceUpdatedNotificationParams extends NotificationParams {
  /** The URI of the resource that has been updated. */
  uri: string;
}

/** A subscribed resource changed and may need to be read again. */
export interface ResourceUpdatedNotification extends JSONRPCNotification {
  method: "notifications/resources/updated";
  params: ResourceUpdatedNotificationParams;
}

/** The list of resources changed. */
export interface ResourceListChangedNotification extends JSONRPCNotification {
  method: "notifications/resources/list_changed";
  params?: NotificationParams;
}

/** A known resource that the server is capable of reading. */
export interface Resource extends BaseMetadata, Icons {
  /** The URI of this resource. */
  uri: string;
  /** A description of what this resource represents; a hint to the model. */
  description?: string;
  /** The MIME type of this resource, if known. */
  mimeType?: string;
  /** Optional annotations for the client. */
  annotations?: Annotations;
  /** The size of the raw resource content, in bytes, if known. */
  size?: number;
  _meta?: MetaObject;
}

/** A template description for resources available on the server. */
export interface ResourceTemplate extends BaseMetadata, Icons {
  /** An RFC 6570 URI template that constructs resource URIs. */
  uriTemplate: string;
  /** A description of what this template is for. */
  description?: string;
  /** The MIME type of every resource matching this template, if they share one. */
  mimeType?: string;
  /** Optional annotations for the client. */
  annotations?: Annotations;
  _meta?: MetaObject;
}

/** The contents of a specific resource or sub-resource. */
export interface ResourceContents {
  /** The URI of this resource. */
  uri: string;
  /** The MIME type of this resource, if known. */
  mimeType?: string;
  _meta?: MetaObject;
}

/** Text resource contents. */
export interface TextResourceContents extends ResourceContents {
  /** The text of the item. */
  text: string;
}

/** Binary resource contents. */
export interface BlobResourceContents extends ResourceContents {
  /** Base64-encoded binary data. */
  blob: string;
}

/* Prompts */

/** The result of `prompts/list`. */
export interface ListPromptsResult extends PaginatedResult, CacheableResult {
  prompts: Prompt[];
}

/** Parameters for a `prompts/get` request. */
export interface GetPromptRequestParams extends InputResponseRequestParams {
  /** The name of the prompt or prompt template. */
  name: string;
  /** Arguments to use for templating the prompt. */
  arguments?: { [key: string]: string };
}

/** The result of `prompts/get`. */
export interface GetPromptResult extends Result {
  /** An optional description for the prompt. */
  description?: string;
  messages: PromptMessage[];
}

/** A prompt or prompt template that the server offers. */
export interface Prompt extends BaseMetadata, Icons {
  /** An optional description of what this prompt provides. */
  description?: string;
  /** A list of arguments to use for templating the prompt. */
  arguments?: PromptArgument[];
  _meta?: MetaObject;
}

/** Describes an argument that a prompt can accept. */
export interface PromptArgument extends BaseMetadata {
  /** A human-readable description of the argument. */
  description?: string;
  /** Whether this argument must be provided. */
  required?: boolean;
}

/** The sender or recipient of messages and data in a conversation. */
export type Role = "user" | "assistant";

/** A message returned as part of a prompt. */
export interface PromptMessage {
  role: Role;
  content: ContentBlock;
}

/** A link to a resource, in a prompt or tool call result. */
export interface ResourceLink extends Resource {
  type: "resource_link";
}

/** The contents of a resource, embedded into a prompt or tool call result. */
export interface EmbeddedResource {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  /** Optional annotations for the client. */
  annotations?: Annotations;
  _meta?: MetaObject;
}

/** The list of prompts changed. */
export interface PromptListChangedNotification extends JSONRPCNotification {
  method: "notifications/prompts/list_changed";
  params?: NotificationParams;
}

/* Tools */

/** The result of `tools/list`. */
export interface ListToolsResult extends PaginatedResult, CacheableResult {
  tools: Tool[];
}

/** The result of `tools/call`. */
export interface CallToolResult extends Result {
  /** The unstructured result of the tool call. */
  content: ContentBlock[];
  /** Any JSON value, conforming to the tool's `outputSchema` if it has one. */
  structuredContent?: unknown;
  /**
   * Whether the tool call ended in an error. Tool errors SHOULD be reported
   * here, not as protocol errors, so the model can see them and self-correct.
   */
  isError?: boolean;
}

/** Parameters for a `tools/call` request. */
export interface CallToolRequestParams extends InputResponseRequestParams {
  /** The name of the tool. */
  name: string;
  /** Arguments to use for the tool call. */
  arguments?: { [key: string]: unknown };
}

/** The list of tools changed. */
export interface ToolListChangedNotification extends JSONRPCNotification {
  method: "notifications/tools/list_changed";
  params?: NotificationParams;
}

/**
 * Hints describing a {@link Tool}. Clients should never make tool use
 * decisions based on annotations from untrusted servers.
 */
export interface ToolAnnotations {
  /** A human-readable title for the tool. */
  title?: string;
  /** If true, the tool does not modify its environment. Default false. */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive updates. Default true. */
  destructiveHint?: boolean;
  /** If true, repeated calls with the same arguments have no additional effect. Default false. */
  idempotentHint?: boolean;
  /** If true, the tool interacts with an open world of external entities. Default true. */
  openWorldHint?: boolean;
}

/** Definition for a tool the client can call. */
export interface Tool extends BaseMetadata, Icons {
  /** A human-readable description of the tool; a hint to the model. */
  description?: string;
  /**
   * A JSON Schema (2020-12 unless `$schema` says otherwise) for the
   * arguments, with `type: "object"` at the root. Properties may carry an
   * `x-mcp-header` annotation to mirror the argument into an HTTP header.
   */
  inputSchema: { $schema?: string; type: "object"; [key: string]: unknown };
  /** An optional JSON Schema for `structuredContent`. */
  outputSchema?: { $schema?: string; [key: string]: unknown };
  /** Display name precedence: `title`, `annotations.title`, then `name`. */
  annotations?: ToolAnnotations;
  _meta?: MetaObject;
}

/* Logging */

/**
 * Parameters for a `notifications/message` notification.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface LoggingMessageNotificationParams extends NotificationParams {
  /** The severity of this log message. */
  level: LoggingLevel;
  /** An optional name of the logger issuing this message. */
  logger?: string;
  /** The data to be logged; any JSON value. */
  data: unknown;
}

/**
 * A log message, sent only for requests that set
 * `io.modelcontextprotocol/logLevel`.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface LoggingMessageNotification extends JSONRPCNotification {
  method: "notifications/message";
  params: LoggingMessageNotificationParams;
}

/**
 * The severity of a log message, as RFC 5424 syslog severities.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export type LoggingLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

/* Sampling */

/**
 * Parameters for a `sampling/createMessage` request.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface CreateMessageRequestParams {
  messages: SamplingMessage[];
  /** The server's preferences for which model to select. */
  modelPreferences?: ModelPreferences;
  /** An optional system prompt; the client MAY modify or omit it. */
  systemPrompt?: string;
  /**
   * Context to include. `"thisServer"` and `"allServers"` are deprecated
   * (SEP-2596) and need the `sampling.context` client capability.
   */
  includeContext?: "none" | "thisServer" | "allServers";
  temperature?: number;
  /** The requested maximum number of tokens to sample. */
  maxTokens: number;
  stopSequences?: string[];
  /** Provider-specific metadata to pass through. */
  metadata?: JSONObject;
  /** Tools the model may use; needs the `sampling.tools` client capability. */
  tools?: Tool[];
  /** How the model uses tools; needs the `sampling.tools` client capability. */
  toolChoice?: ToolChoice;
}

/**
 * Controls tool selection behavior for sampling requests.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface ToolChoice {
  mode?: "auto" | "required" | "none";
}

/**
 * Asks the client to sample an LLM.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface CreateMessageRequest {
  method: "sampling/createMessage";
  params: CreateMessageRequestParams;
}

/**
 * The client's sampled message.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface CreateMessageResult extends SamplingMessage {
  /** The name of the model that generated the message. */
  model: string;
  /** Why sampling stopped: `endTurn`, `stopSequence`, `maxTokens`, `toolUse` or a provider value. */
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | "toolUse" | string;
}

/**
 * A message issued to or received from an LLM API.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface SamplingMessage {
  role: Role;
  content: SamplingMessageContentBlock | SamplingMessageContentBlock[];
  _meta?: MetaObject;
}

/** @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577). */
export type SamplingMessageContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ToolUseContent
  | ToolResultContent;

/** Optional annotations for the client. */
export interface Annotations {
  /** Who the intended audience of this object or data is. */
  audience?: Role[];
  /** Importance from 0 (optional) to 1 (effectively required). */
  priority?: number;
  /** When the resource was last modified, as an ISO 8601 string. */
  lastModified?: string;
}

/** Content in prompts and tool results. */
export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;

/** Text provided to or from an LLM. */
export interface TextContent {
  type: "text";
  /** The text content of the message. */
  text: string;
  annotations?: Annotations;
  _meta?: MetaObject;
}

/** An image provided to or from an LLM. */
export interface ImageContent {
  type: "image";
  /** The base64-encoded image data. */
  data: string;
  /** The MIME type of the image. */
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
}

/** Audio provided to or from an LLM. */
export interface AudioContent {
  type: "audio";
  /** The base64-encoded audio data. */
  data: string;
  /** The MIME type of the audio. */
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
}

/**
 * A request from the assistant to call a tool.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface ToolUseContent {
  type: "tool_use";
  /** A unique identifier for this tool use. */
  id: string;
  /** The name of the tool to call. */
  name: string;
  /** The arguments, conforming to the tool's input schema. */
  input: { [key: string]: unknown };
  _meta?: MetaObject;
}

/**
 * The result of a tool use, provided back to the assistant.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface ToolResultContent {
  type: "tool_result";
  /** The ID of the tool use this result corresponds to. */
  toolUseId: string;
  /** The unstructured result content of the tool use. */
  content: ContentBlock[];
  /** An optional structured result value. */
  structuredContent?: unknown;
  /** Whether the tool use resulted in an error. */
  isError?: boolean;
  _meta?: MetaObject;
}

/**
 * The server's advisory preferences for model selection during sampling.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface ModelPreferences {
  /** Hints evaluated in order; the first match is taken. */
  hints?: ModelHint[];
  /** 0 to 1: how much cost matters. */
  costPriority?: number;
  /** 0 to 1: how much latency matters. */
  speedPriority?: number;
  /** 0 to 1: how much capability matters. */
  intelligencePriority?: number;
}

/**
 * A hint for model selection: a substring of a model name.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface ModelHint {
  name?: string;
}

/* Autocomplete */

/** Parameters for a `completion/complete` request. */
export interface CompleteRequestParams extends RequestParams {
  ref: PromptReference | ResourceTemplateReference;
  /** The argument being completed. */
  argument: {
    /** The name of the argument. */
    name: string;
    /** The value of the argument to use for completion matching. */
    value: string;
  };
  /** Additional, optional context for completions. */
  context?: {
    /** Previously-resolved variables in a URI template or prompt. */
    arguments?: { [key: string]: string };
  };
}

/** The result of `completion/complete`. */
export interface CompleteResult extends Result {
  completion: {
    /** At most 100 completion values. */
    values: string[];
    /** The total number of completion options available. */
    total?: number;
    /** Whether there are more options than `values` holds. */
    hasMore?: boolean;
  };
}

/** A reference to a resource or resource template definition. */
export interface ResourceTemplateReference {
  type: "ref/resource";
  /** The URI or URI template of the resource. */
  uri: string;
}

/** Identifies a prompt. */
export interface PromptReference extends BaseMetadata {
  type: "ref/prompt";
}

/* Roots */

/**
 * Asks the client for its root URIs.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface ListRootsRequest {
  method: "roots/list";
  params?: {
    _meta?: MetaObject;
  };
}

/**
 * The client's roots.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface ListRootsResult {
  roots: Root[];
}

/**
 * A root directory or file that the server can operate on.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
 */
export interface Root {
  /** The URI identifying the root; must start with `file://` for now. */
  uri: string;
  /** An optional human-readable name for the root. */
  name?: string;
  _meta?: MetaObject;
}

/** A form-mode elicitation: non-sensitive information through a form. */
export interface ElicitRequestFormParams {
  /** The elicitation mode; absent means form. */
  mode?: "form";
  /** The message to present to the user. */
  message: string;
  /** A restricted JSON Schema: top-level primitive properties only. */
  requestedSchema: {
    $schema?: string;
    type: "object";
    properties: {
      [key: string]: PrimitiveSchemaDefinition;
    };
    required?: string[];
  };
}

/** A URL-mode elicitation: an out-of-band interaction at a URL. */
export interface ElicitRequestURLParams {
  mode: "url";
  /** The message explaining why the interaction is needed. */
  message: string;
  /** The URL that the user should navigate to. */
  url: string;
}

/** The parameters of an elicitation request. */
export type ElicitRequestParams =
  | ElicitRequestFormParams
  | ElicitRequestURLParams;

/** Asks the client to elicit information from the user. */
export interface ElicitRequest {
  method: "elicitation/create";
  params: ElicitRequestParams;
}

/** Primitive property schemas allowed in an elicitation form. */
export type PrimitiveSchemaDefinition =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | EnumSchema;

/** A string field. */
export interface StringSchema {
  type: "string";
  title?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  format?: "email" | "uri" | "date" | "date-time";
  default?: string;
}

/** A number or integer field. */
export interface NumberSchema {
  type: "number" | "integer";
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: number;
}

/** A boolean field. */
export interface BooleanSchema {
  type: "boolean";
  title?: string;
  description?: string;
  default?: boolean;
}

/** Single selection without display titles. */
export interface UntitledSingleSelectEnumSchema {
  type: "string";
  title?: string;
  description?: string;
  enum: string[];
  default?: string;
}

/** Single selection with display titles. */
export interface TitledSingleSelectEnumSchema {
  type: "string";
  title?: string;
  description?: string;
  oneOf: Array<{ const: string; title: string }>;
  default?: string;
}

/** Single selection. */
export type SingleSelectEnumSchema =
  | UntitledSingleSelectEnumSchema
  | TitledSingleSelectEnumSchema;

/** Multiple selection without display titles. */
export interface UntitledMultiSelectEnumSchema {
  type: "array";
  title?: string;
  description?: string;
  minItems?: number;
  maxItems?: number;
  items: { type: "string"; enum: string[] };
  default?: string[];
}

/** Multiple selection with display titles. */
export interface TitledMultiSelectEnumSchema {
  type: "array";
  title?: string;
  description?: string;
  minItems?: number;
  maxItems?: number;
  items: { anyOf: Array<{ const: string; title: string }> };
  default?: string[];
}

/** Multiple selection. */
export type MultiSelectEnumSchema =
  | UntitledMultiSelectEnumSchema
  | TitledMultiSelectEnumSchema;

/** Use {@link TitledSingleSelectEnumSchema} instead. */
export interface LegacyTitledEnumSchema {
  type: "string";
  title?: string;
  description?: string;
  enum: string[];
  /** (Legacy) Display names for enum values. */
  enumNames?: string[];
  default?: string;
}

/** Any enum field. */
export type EnumSchema =
  | SingleSelectEnumSchema
  | MultiSelectEnumSchema
  | LegacyTitledEnumSchema;

/** The client's answer to an elicitation. */
export interface ElicitResult {
  /**
   * `accept`: submitted or consented; `decline`: explicitly declined;
   * `cancel`: dismissed without a choice.
   */
  action: "accept" | "decline" | "cancel";
  /** The submitted form data; only for `accept` in form mode. */
  content?: { [key: string]: string | number | boolean | string[] };
}

/* Method names */

/** Every client request method of this revision. */
export type ClientRequestMethod =
  | "server/discover"
  | "completion/complete"
  | "prompts/get"
  | "prompts/list"
  | "resources/list"
  | "resources/templates/list"
  | "resources/read"
  | "subscriptions/listen"
  | "tools/call"
  | "tools/list"
  // The tasks extension (`io.modelcontextprotocol/tasks`).
  | "tasks/get"
  | "tasks/update"
  | "tasks/cancel";

/** Every notification a server sends on Streamable HTTP. */
export type ServerNotification =
  | ProgressNotification
  | LoggingMessageNotification
  | ResourceUpdatedNotification
  | ResourceListChangedNotification
  | ToolListChangedNotification
  | PromptListChangedNotification
  | SubscriptionsAcknowledgedNotification
  | CancelledNotification
  // The tasks extension (`io.modelcontextprotocol/tasks`).
  | TaskStatusNotification;
