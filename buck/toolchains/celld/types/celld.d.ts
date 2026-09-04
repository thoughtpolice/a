// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Ambient platform declarations for celld 0.5.1's Cloudflare Workers surface.
 *
 * These declarations are derived from the v0.5.1 release source's
 * `docs/cloudflare-compat.md`, `crates/celld/js.rs`, and `crates/celld/js/`:
 * https://github.com/denoland/celld/tree/v0.5.1/crates/celld/js
 * They cover Workers, Durable Objects, D1, KV, Queues, R2, Workflows, and
 * Dynamic Workers, Durable Object facets, experimental Containers, and sockets.
 * Workers AI was removed in 0.5.0: use an application-owned provider client.
 * Web-standard APIs supplied by TypeScript's DOM library are not repeated
 * unless celld extends them. Unsupported operations are omitted or explicitly
 * documented as compatibility placeholders.
 *
 * This is the shared platform boundary for applications using the celld
 * toolchain. It describes runtime primitives only and never imports application
 * types. Consumers declare a Buck dependency on `toolchains//celld:types` and
 * load this file through their TypeScript configuration.
 *
 * @module
 */

/** A binding capable of dispatching HTTP requests to a Worker or cell. */
interface Fetcher {
  /** Dispatches an HTTP request and resolves with the target's response. */
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;

  /**
   * Invokes a same-script service binding's scheduled handler.
   *
   * celld exposes this test-oriented helper only when the target is the
   * current script, has no named entrypoint, and defines `scheduled`.
   */
  scheduled?(options?: {
    /** Scheduled occurrence time; celld uses the current time when omitted. */
    scheduledTime?: number | Date;
    /** Cron expression reported to the scheduled handler. */
    cron?: string;
  }): Promise<{
    /** Successful handler outcome. A thrown handler rejects instead. */
    outcome: "ok";
    /** Whether the handler called `ScheduledController.noRetry()`. */
    noRetry: boolean;
  }>;

  /**
   * Performs a deprecated GET helper and decodes the body as text.
   *
   * Returns `null` for HTTP 404 or 410. This method is absent when the
   * `fetcher_no_get_put_delete` compatibility flag is enabled.
   */
  get?(url: string, type?: "text"): Promise<string | null>;

  /** Performs the deprecated GET helper and decodes the body as bytes. */
  get?(url: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;

  /** Performs the deprecated GET helper and decodes the body as JSON. */
  get?<Value = unknown>(url: string, type: "json"): Promise<Value | null>;

  /** Performs the deprecated GET helper and returns the response body stream. */
  get?(url: string, type: "stream"): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Performs a deprecated PUT helper.
   *
   * Expiration values are encoded as query parameters. The promise rejects
   * when the response status is outside the 2xx range.
   */
  put?(url: string, body: BodyInit | null, options?: {
    /** Absolute expiration value forwarded as the `expiration` parameter. */
    expiration?: number | string;
    /** Relative expiration forwarded as the `expiration_ttl` parameter. */
    expirationTtl?: number | string;
  }): Promise<void>;

  /** Performs a deprecated DELETE helper and rejects for a non-2xx response. */
  delete?(url: string): Promise<void>;
}

/**
 * An `env` binding that dispatches HTTP requests and typed public method calls
 * to another Worker. Supply the entrypoint instance type or an application-owned
 * method contract as `T`; omission retains the untyped HTTP-only surface.
 *
 * This deliberately exposes only the portable method-call subset: results are
 * ordinary promises, not same-isolate capabilities or property pipelines.
 * Classes must implement methods on their prototype, not as instance fields.
 * TypeScript cannot distinguish a function-valued field from a method, nor
 * prove that arguments/results are cloneable. Use structured-clone data and
 * actual `#private` helpers; a TypeScript `private` modifier is erased at runtime.
 */
type ServiceBinding<T extends object = object> =
  & Fetcher
  & CelldRemoteMethods<T, CelldRemoteReserved>;

/** An `env` binding that fetches files from a celld static-assets deployment. */
type AssetsBinding = Fetcher;

/** Per-event context supplied to Worker handlers and entrypoints. */
interface ExecutionContext<
  Exports extends object = Record<string, unknown>,
  Props = unknown,
> {
  /** Keeps work registered with the current event alive after its reply. */
  waitUntil(promise: Promise<unknown>): void;

  /** Accepted for Workers compatibility; celld has no CDN fallback behavior. */
  passThroughOnException(): void;

  /** Aborts the current request context and rejects its outstanding RPC work. */
  abort(reason?: unknown): void;

  /** Loopback RPC stubs and Durable Object namespaces exported by this script. */
  readonly exports: Exports;

  /** Per-instance properties carried by a loopback entrypoint stub. */
  readonly props: Props;
}

/** Metadata and retry control passed to a cron-triggered handler. */
interface ScheduledController {
  /** Milliseconds since the Unix epoch for the cron occurrence being handled. */
  readonly scheduledTime: number;

  /** The configured cron expression that produced this occurrence. */
  readonly cron: string;

  /** Prevents celld from retrying this handler if it subsequently throws. */
  noRetry(): void;
}

/** Metadata passed to a Durable Object alarm handler. */
interface AlarmInvocationInfo {
  /** Milliseconds since the Unix epoch at which the alarm was scheduled. */
  readonly scheduledTime: number;

  /** Number of prior attempts for this alarm delivery. */
  readonly retryCount: number;

  /** Whether this delivery is a retry rather than the first attempt. */
  readonly isRetry: boolean;
}

/** Object-style handlers accepted as a Worker's default module export. */
interface ExportedHandler<
  Env = unknown,
  Exports extends object = Record<string, unknown>,
  Props = unknown,
  QueueBody = unknown,
> {
  /** Handles an incoming HTTP request. */
  fetch?(
    request: Request,
    env: Env,
    ctx: ExecutionContext<Exports, Props>,
  ): Response | Promise<Response>;

  /** Handles a durable celld cron occurrence. */
  scheduled?(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext<Exports, Props>,
  ): void | Promise<void>;

  /**
   * Handles a push-delivered Queue batch; successful return acknowledges
   * unsettled messages. A consumer script cannot also export `fetch` in celld.
   */
  queue?(
    batch: MessageBatch<QueueBody>,
    env: Env,
    ctx: ExecutionContext<Exports, Props>,
  ): void | Promise<void>;
}

/** Event methods that celld can dispatch to a Durable Object instance. */
interface DurableObject {
  /** Handles an HTTP request sent through a Durable Object stub. */
  fetch?(request: Request): Response | Promise<Response>;

  /** Handles a persisted alarm occurrence. */
  alarm?(info?: AlarmInvocationInfo): void | Promise<void>;

  /** Handles a text or binary message on a hibernatable WebSocket. */
  webSocketMessage?(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): void | Promise<void>;

  /** Handles a hibernatable WebSocket close event. */
  webSocketClose?(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void | Promise<void>;

  /** Handles an error raised by a hibernatable WebSocket. */
  webSocketError?(socket: WebSocket, error: unknown): void | Promise<void>;
}

/** Key-range and ordering controls shared by asynchronous and synchronous storage lists. */
interface DurableObjectListOptions {
  /** Includes only keys lexicographically greater than or equal to this key. */
  start?: string;

  /** Includes only keys lexicographically less than this key. */
  end?: string;

  /** Includes only keys lexicographically greater than this key. */
  startAfter?: string;

  /** Includes only keys beginning with this prefix. */
  prefix?: string;

  /** Returns keys in descending lexicographic order. */
  reverse?: boolean;

  /** Caps the number of returned entries. */
  limit?: number;
}

/** A positional value accepted by Durable Object SQLite statements. */
type SqlStorageBindable =
  | null
  | string
  | number
  | ArrayBuffer
  | ArrayBufferView;

/** A value returned from Durable Object SQLite; BLOBs are `ArrayBuffer`s. */
type SqlStorageValue = null | string | number | ArrayBuffer;

/** One object-shaped row returned from Durable Object SQLite. */
type SqlStorageRow = Record<string, SqlStorageValue>;

/** A streaming cursor over one Durable Object SQLite statement result. */
interface SqlStorageCursor<Row extends SqlStorageRow = SqlStorageRow>
  extends IterableIterator<Row> {
  /** Column names in query-result order. */
  readonly columnNames: string[];

  /** Number of result rows read from the underlying cursor so far. */
  readonly rowsRead: number;

  /** Number of database rows changed by the statement. */
  readonly rowsWritten: number;

  /** Materializes all unread rows, subject to celld's isolate heap guard. */
  toArray(): Row[];

  /** Returns exactly one row and throws if the result count is not one. */
  one(): Row;

  /** Iterates unread rows as positional value arrays instead of objects. */
  raw(): IterableIterator<SqlStorageValue[]>;
}

/** Synchronous SQLite API attached to a Durable Object's storage. */
interface SqlStorage {
  /** Executes one SQL statement with positional bindings and returns a cursor. */
  exec<Row extends SqlStorageRow = SqlStorageRow>(
    query: string,
    ...bindings: SqlStorageBindable[]
  ): SqlStorageCursor<Row>;

  /** Compiles a reusable statement function that accepts positional bindings. */
  prepare<Row extends SqlStorageRow = SqlStorageRow>(
    query: string,
  ): (...bindings: SqlStorageBindable[]) => SqlStorageCursor<Row>;

  /** Executes as many complete statements as possible from a SQL string. */
  ingest(sql: string): {
    /** Unconsumed suffix beginning at an incomplete statement, if any. */
    remainder: string;
    /** Total number of database rows changed by consumed statements. */
    rowsWritten: number;
    /** Number of complete statements consumed. */
    statementCount: number;
  };

  /** Current SQLite database file size in bytes. */
  readonly databaseSize: number;
}

/** Synchronous key/value storage backed by the Durable Object's SQLite database. */
interface DurableObjectSyncStorage {
  /** Reads a structured-clone value, or `undefined` when the key is absent. */
  get<T>(key: string): T | undefined;

  /** Stores a structured-clone value under one key. */
  put<T>(key: string, value: T): void;

  /** Deletes one key and reports whether it existed. */
  delete(key: string): boolean;

  /** Iterates matching key/value pairs; only one live list iterator is allowed. */
  list<T>(options?: DurableObjectListOptions): IterableIterator<[string, T]>;
}

/** Durable Object persistence, transactions, SQLite, and alarm operations. */
interface DurableObjectStorage {
  /** Synchronous SQL access to the cell's SQLite database. */
  readonly sql: SqlStorage;

  /** Synchronous structured-clone key/value access. */
  readonly kv: DurableObjectSyncStorage;

  /** Reads one asynchronous key/value entry. */
  get<T>(key: string): Promise<T | undefined>;

  /** Reads multiple asynchronous key/value entries into a map. */
  get<T>(keys: string[]): Promise<Map<string, T>>;

  /** Writes one asynchronous key/value entry. */
  put<T>(key: string, value: T): Promise<void>;

  /** Atomically writes the entries from an object or map. */
  put<T>(entries: Record<string, T> | Map<string, T>): Promise<void>;

  /** Deletes one key and reports whether it existed. */
  delete(key: string): Promise<boolean>;

  /** Deletes multiple keys and returns the number that existed. */
  delete(keys: string[]): Promise<number>;

  /** Reads matching entries into a lexicographically ordered map. */
  list<T>(options?: DurableObjectListOptions): Promise<Map<string, T>>;

  /** Deletes every key/value entry and, depending on compatibility, the alarm. */
  deleteAll(): Promise<void>;

  /**
   * Waits for earlier committed writes to reach the fleet ensemble/object store,
   * or just the local commit when no object store exists. Rejects during a
   * transaction, after abort, or with an unfinished SQL write cursor. Consume
   * RETURNING rows before sync, replies, or outbound effects; read cursors may
   * remain open. The configured durability/operation deadlines bound this wait.
   */
  sync(): Promise<void>;

  /** Creates or replaces this Durable Object's single alarm; facets currently reject alarms. */
  setAlarm(scheduledTime: number | Date): Promise<void>;

  /** Reads the alarm time in Unix milliseconds, or `null` when none is set. */
  getAlarm(): Promise<number | null>;

  /** Deletes this Durable Object's alarm. */
  deleteAlarm(): Promise<void>;

  /** Runs a serialized asynchronous transaction; a 30-second timeout resets the object. */
  transaction<T>(
    callback: (transaction: DurableObjectStorage) => T | Promise<T>,
  ): Promise<T>;

  /** Runs a synchronous transaction or nested SQLite savepoint. */
  transactionSync<T>(callback: (transaction: DurableObjectStorage) => T): T;

  /** Explicitly rolls back the current transaction; invalid outside a transaction. */
  rollback(): void;
}

/** Stable, namespace-scoped identity for one Durable Object. */
interface DurableObjectId {
  /** Original name when this ID was derived from a recoverable short name. */
  readonly name?: string;

  /** Jurisdiction metadata; celld currently does not implement restrictions. */
  readonly jurisdiction?: string;

  /** Reports whether another ID has the same encoded identity. */
  equals(other: DurableObjectId): boolean;

  /** Returns the encoded ID accepted by `DurableObjectNamespace.idFromString`. */
  toString(): string;
}

/** Request and response strings for hibernatable WebSocket auto-response. */
interface WebSocketRequestResponsePair {
  /** Incoming text message that should be answered without waking the object. */
  readonly request: string;

  /** Text response celld sends when the request matches. */
  readonly response: string;
}

/** Constructor for a hibernatable WebSocket auto-response pair. */
declare const WebSocketRequestResponsePair: {
  /** Prototype shared by auto-response pair instances. */
  prototype: WebSocketRequestResponsePair;

  /** Creates a request/response match pair; each string is limited to 2048 UTF-8 bytes. */
  new (request: string, response: string): WebSocketRequestResponsePair;
};

/** Runtime context associated with one active Durable Object. */
interface DurableObjectState<
  Exports extends object = Record<string, unknown>,
  Props = unknown,
> {
  /** Identity of the active Durable Object. */
  readonly id: DurableObjectId;

  /** Persistent storage and alarm interface for the active object. */
  readonly storage: DurableObjectStorage;

  /** Loopback entrypoints and namespaces exported by the current script. */
  readonly exports: Exports;

  /** Properties passed when loading a facet class; undefined for a root object. */
  readonly props: Props;

  /** Child objects with separate SQLite databases replicated with this root. */
  readonly facets: DurableObjectFacets;

  /** Present only for a class configured in the deployment's containers array. */
  readonly container?: Container;

  /** Prevents other events from entering until the callback settles; times out after 30 seconds. */
  blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T>;

  /** Aborts and resets the current object instance. */
  abort(reason?: unknown): void;

  /** Registers background work; pending object I/O already survives the handler return. */
  waitUntil(promise: Promise<unknown>): void;

  /** Returns accepted hibernatable WebSockets, optionally filtered by tag. */
  getWebSockets(tag?: string): WebSocket[];

  /** Reads tags from a WebSocket previously accepted for hibernation. */
  getTags(socket: WebSocket): string[];

  /** Transfers a WebSocket to celld's hibernatable cell storage. */
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;

  /** Sets an auto-response pair, or clears it when passed `null` or omitted. */
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair | null): void;

  /** Returns the configured auto-response pair, or `null` when disabled. */
  getWebSocketAutoResponse(): WebSocketRequestResponsePair | null;

  /** Returns the most recent auto-response time for a socket, if one exists. */
  getWebSocketAutoResponseTimestamp(socket: WebSocket): Date | null;
}

/** Identity and HTTP transport members supplied by every Durable Object stub. */
interface CelldDurableObjectStub extends Omit<Fetcher, "scheduled"> {
  /** Stable identity of the addressed object. */
  readonly id: DurableObjectId;

  /** Recovered object name when the ID was created from a sufficiently short name. */
  readonly name?: string;
}

/**
 * Addressable client for one Durable Object, optionally parameterized by its
 * public method contract or class instance type. Method results are awaited
 * promises; non-function fields and the stub's own members are excluded from
 * this application RPC surface. `fetch` remains the ordinary HTTP method.
 *
 * Unlike service entrypoints, celld 0.5.0 DO dispatch accepts function-valued
 * instance members, including lifecycle handlers and own arrow-function fields.
 * These methods are therefore present when declared by `T`. Types are not an
 * access-control layer: use real `#private` helpers and validate public inputs.
 * Arguments/results should be structured-clone data; these types neither
 * validate cloneability nor promise transferable capabilities or pipelining.
 */
type DurableObjectStub<T extends object = object> =
  & CelldDurableObjectStub
  & CelldRemoteMethods<T, CelldDurableObjectReserved>;

/** Binding used to construct IDs and obtain typed stubs for one Durable Object class. */
interface DurableObjectNamespace<T extends object = object> {
  /** Deterministically derives an object ID from a name. */
  idFromName(name: string): DurableObjectId;

  /** Validates and reconstructs an object ID from its encoded string. */
  idFromString(id: string): DurableObjectId;

  /** Creates a random object ID; celld rejects jurisdiction restrictions. */
  newUniqueId(
    options?: {
      /** Only a nullish restriction is accepted; real jurisdiction restrictions reject. */
      jurisdiction?: null;
    } | null,
  ): DurableObjectId;

  /** Returns this namespace for a nullish value; celld rejects real restrictions. */
  jurisdiction(jurisdiction?: null): DurableObjectNamespace<T>;

  /** Returns a client stub for a previously constructed ID. */
  get(id: DurableObjectId, options?: unknown): DurableObjectStub<T>;

  /** Derives an ID from a name and returns its client stub. */
  getByName(name: string, options?: unknown): DurableObjectStub<T>;
}

/** Error raised when celld cannot route a request to a cell's current owner. */
interface DurableObjectRoutingError extends Error {
  /** Stable machine-readable routing error code. */
  readonly code: "owner_unreachable";

  /** Indicates that the caller may retry the routing operation. */
  readonly retryable: true;

  /** Internal cell scope, when celld can identify it. */
  readonly scope?: string;

  /** Current owner identifier, when celld can identify it. */
  readonly owner?: string;
}

/** Constructor for celld's retryable Durable Object routing error. */
declare const DurableObjectRoutingError: {
  /** Prototype shared by routing errors. */
  prototype: DurableObjectRoutingError;

  /** Creates an owner-unreachable routing error with optional diagnostic detail. */
  new (detail?: {
    /** Internal cell scope associated with the failure. */
    scope?: string;
    /** Owner identifier associated with the failure. */
    owner?: string;
  }): DurableObjectRoutingError;
};

/** celld-specific methods added to the standard WebSocket interface. */
interface WebSocket {
  /** Starts message delivery on an outbound or upgraded client WebSocket. */
  accept(): void;

  /** Persists structured-clone metadata with a hibernatable WebSocket. */
  serializeAttachment(value: unknown): void;

  /** Restores metadata previously stored with `serializeAttachment`. */
  deserializeAttachment<T = unknown>(): T | undefined;
}

/** celld extension carrying the client end of a successful WebSocket upgrade. */
interface Response {
  /** Upgraded client WebSocket when this response represents a cell upgrade. */
  readonly webSocket?: WebSocket;

  /** Application-supplied metadata copied from ResponseInit; no inferred edge fields. */
  readonly cf?: Record<string, unknown>;
}

/** celld extension used to return the server end of a WebSocket upgrade. */
interface ResponseInit {
  /** Server WebSocket paired with an HTTP 101 response. */
  webSocket?: WebSocket;

  /** Application metadata retained on the Response instance. */
  cf?: Record<string, unknown>;
}

/** celld inbound request metadata contains no Cloudflare geolocation or TLS claims. */
interface Request {
  /** Empty for incoming requests, unless application code supplies custom metadata. */
  readonly cf?: Record<string, unknown>;
}

/** Request metadata can be passed through by application code, without edge behavior. */
interface RequestInit {
  /** Metadata copied to Request.cf; Cloudflare-specific fetch optimizations are unavailable. */
  cf?: Record<string, unknown>;
}

/** Cloudflare's default cache handle; celld validates writes but always misses reads. */
interface CacheStorage {
  /** A no-storage cache whose put consumes bodies, match misses, and delete returns false. */
  readonly default: Cache;
}

/** The indexed and iterable client/server sockets returned by `new WebSocketPair()`. */
interface WebSocketPair extends Iterable<WebSocket> {
  /** Client end of the in-isolate WebSocket pair. */
  readonly 0: WebSocket;

  /** Server end normally returned in an HTTP 101 response. */
  readonly 1: WebSocket;

  /** Fixed pair length. */
  readonly length: 2;
}

/** Constructor for an in-isolate WebSocket pair. */
declare const WebSocketPair: {
  /** Prototype exposed for Workers compatibility. */
  prototype: WebSocketPair;

  /** Allocates connected client and server WebSockets. */
  new (): WebSocketPair;
};

/** celld's constant-time comparison extension to the standard Web Crypto API. */
interface SubtleCrypto {
  /** Compares equal-length byte buffers without data-dependent early exit. */
  timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
}

/** Reported compatibility switches; celld does not expose every configured flag here. */
interface CelldCompatibilityFlags {
  /** Whether `DurableObjectStorage.deleteAll()` also deletes the alarm. */
  readonly delete_all_deletes_alarm?: boolean;

  /** Whether classes not extending the Durable Object base can receive RPC. */
  readonly js_rpc?: boolean;

  /** Whether the pre-v1 sqlite-vec extension is enabled. */
  readonly sqlite_vec?: boolean;

  /** Whether deprecated Fetcher GET, PUT, and DELETE helpers are absent. */
  readonly fetcher_no_get_put_delete?: boolean;

  /** Whether WebSocket binary data uses the WHATWG `Blob` default. */
  readonly websocket_standard_binary_type?: boolean;

  /** Future celld-recognized flags remain safely inspectable by name. */
  readonly [flag: string]: boolean | undefined;
}

/** celld's Cloudflare-compatible runtime metadata namespace. */
declare const Cloudflare: {
  /** Flags celld actually models; accepted but unimplemented flags are absent. */
  readonly compatibilityFlags: Readonly<CelldCompatibilityFlags>;
};

/** Cooperative timer scheduler exposed in the Worker global scope. */
declare const scheduler: {
  /** Resolves after at least the requested number of milliseconds. */
  wait(delay: number): Promise<void>;
};

/**
 * Schedules a callback in a later timer task, after queued microtasks.
 *
 * @param callback Function invoked by the timer task.
 * @param arguments_ Positional values forwarded to the callback.
 * @returns Numeric handle accepted by `clearImmediate` or the timer clear APIs.
 */
declare function setImmediate<Arguments extends unknown[]>(
  callback: (...arguments_: Arguments) => void,
  ...arguments_: Arguments
): number;

/** Cancels a callback previously registered with `setImmediate`. */
declare function clearImmediate(handle?: number): void;

/** Cloudflare-compatible identity transform specialized for byte chunks. */
declare class IdentityTransformStream
  extends TransformStream<Uint8Array, Uint8Array> {
  /** Creates a byte-oriented identity stream. */
  constructor(queuingStrategy?: QueuingStrategy<Uint8Array>);
}

/** Identity stream that enforces an exact total byte count. */
declare class FixedLengthStream extends IdentityTransformStream {
  /** Creates a stream that errors if it receives more or fewer bytes than expected. */
  constructor(
    expectedLength: number,
    queuingStrategy?: QueuingStrategy<Uint8Array>,
  );
}

/** Algorithms accepted by celld's Cloudflare-compatible `DigestStream`. */
type CelldDigestAlgorithm =
  | AlgorithmIdentifier
  | "MD5"
  | "CRC32"
  | "CRC32C"
  | "CRC64-NVME";

/** Writable stream that incrementally computes a cryptographic hash or CRC. */
declare class DigestStream
  extends WritableStream<ArrayBuffer | ArrayBufferView | string> {
  /** Creates a digest stream for a Web Crypto name, MD5, or supported CRC. */
  constructor(algorithm: CelldDigestAlgorithm);

  /** Resolves to the digest bytes when the writable stream closes. */
  readonly digest: Promise<ArrayBuffer>;

  /** Number of bytes written so far. Strings count as their UTF-8 encoding. */
  readonly bytesWritten: bigint;

  /** Disposes the stream and rejects its outstanding digest promise. */
  [Symbol.dispose](): void;
}

/** Whether injected HTML content is parsed as markup rather than escaped text. */
interface HTMLRewriterContentOptions {
  /** Defaults to false, escaping markup metacharacters in inserted text. */
  html?: boolean;
}

/** Element mutations also accept a response or stream, buffered as UTF-8 after the callback. */
type HTMLRewriterContent = string | Response | ReadableStream<Uint8Array>;

/** A mutable element token, valid only until its content-handler promise settles. */
interface HTMLRewriterElement {
  /** Current tag name, writable to rename the element. */
  tagName: string;
  /** Namespace URI of the element. */
  readonly namespaceURI: string;
  /** Whether a mutation removed the element. */
  readonly removed: boolean;
  /** Attribute pairs; modifying attributes invalidates existing iterators. */
  readonly attributes: IterableIterator<[string, string]>;
  /** Reads an attribute, or null when absent. */
  getAttribute(name: string): string | null;
  /** Reports whether an attribute exists. */
  hasAttribute(name: string): boolean;
  /** Sets an attribute and returns this token for chaining. */
  setAttribute(name: string, value: string): this;
  /** Removes an attribute and returns this token. */
  removeAttribute(name: string): this;
  /** Inserts content before the whole element. */
  before(
    content: HTMLRewriterContent,
    options?: HTMLRewriterContentOptions,
  ): this;
  /** Inserts content after the whole element. */
  after(
    content: HTMLRewriterContent,
    options?: HTMLRewriterContentOptions,
  ): this;
  /** Inserts content before the element's children. */
  prepend(
    content: HTMLRewriterContent,
    options?: HTMLRewriterContentOptions,
  ): this;
  /** Inserts content after the element's children. */
  append(
    content: HTMLRewriterContent,
    options?: HTMLRewriterContentOptions,
  ): this;
  /** Replaces the entire element. */
  replace(
    content: HTMLRewriterContent,
    options?: HTMLRewriterContentOptions,
  ): this;
  /** Replaces the children but retains the element itself. */
  setInnerContent(
    content: HTMLRewriterContent,
    options?: HTMLRewriterContentOptions,
  ): this;
  /** Removes the element and its contents. */
  remove(): this;
  /** Removes the surrounding tags while preserving the children. */
  removeAndKeepContent(): this;
  /** Registers a callback for the corresponding end tag. */
  onEndTag(handler: (endTag: HTMLRewriterEndTag) => void | Promise<void>): void;
}

/** Closing tag token; celld exposes a read-only name and string-only insertions. */
interface HTMLRewriterEndTag {
  /** Closing element name. */
  readonly name: string;
  /** Inserts text or markup immediately before this tag. */
  before(content: string, options?: HTMLRewriterContentOptions): this;
  /** Inserts text or markup immediately after this tag. */
  after(content: string, options?: HTMLRewriterContentOptions): this;
  /** Removes this closing tag. */
  remove(): this;
}

/** Shared string-only mutations on comment and text tokens, valid inside their handlers. */
interface HTMLRewriterTextToken {
  /** Whether the token was removed or replaced. */
  readonly removed: boolean;
  /** Inserts text or markup before this token. */
  before(content: string, options?: HTMLRewriterContentOptions): this;
  /** Inserts text or markup after this token. */
  after(content: string, options?: HTMLRewriterContentOptions): this;
  /** Replaces this token with text or markup. */
  replace(content: string, options?: HTMLRewriterContentOptions): this;
  /** Removes this token. */
  remove(): this;
}

/** Comment token whose text may be replaced directly. */
interface HTMLRewriterComment extends HTMLRewriterTextToken {
  /** Comment contents without the surrounding delimiters. */
  text: string;
}

/** Text chunk; a single source text node can produce several callbacks. */
interface HTMLRewriterText extends HTMLRewriterTextToken {
  /** Read-only source text; use replace() to change it. */
  readonly text: string;
  /** True for the final chunk in the source text node. */
  readonly lastInTextNode: boolean;
}

/** Read-only doctype token, with null fields for omitted identifiers. */
interface HTMLRewriterDoctype {
  /** Document type name, if present. */
  readonly name: string | null;
  /** Public identifier, if present. */
  readonly publicId: string | null;
  /** System identifier, if present. */
  readonly systemId: string | null;
}

/** End-of-document token allowing final appended content. */
interface HTMLRewriterDocumentEnd {
  /** Appends escaped text or explicitly selected HTML markup. */
  append(content: string, options?: HTMLRewriterContentOptions): this;
}

/** Selector-scoped callbacks; content tokens cannot be retained beyond an awaited callback. */
interface HTMLRewriterElementContentHandlers {
  /** Called for each matching element. */
  element?(element: HTMLRewriterElement): void | Promise<void>;
  /** Called for comments inside matched elements. */
  comments?(comment: HTMLRewriterComment): void | Promise<void>;
  /** Called for text chunks inside matched elements. */
  text?(text: HTMLRewriterText): void | Promise<void>;
}

/** Document-wide callbacks, including doctype and document completion. */
interface HTMLRewriterDocumentContentHandlers {
  /** Called for each doctype declaration. */
  doctype?(doctype: HTMLRewriterDoctype): void | Promise<void>;
  /** Called for document comments. */
  comments?(comment: HTMLRewriterComment): void | Promise<void>;
  /** Called for document text chunks. */
  text?(text: HTMLRewriterText): void | Promise<void>;
  /** Called at end of document, before the transformed stream closes. */
  end?(end: HTMLRewriterDocumentEnd): void | Promise<void>;
}

/** Streaming HTML transformation backed by celld's lol_html parser. */
declare class HTMLRewriter {
  /** Creates an empty transformation pipeline. */
  constructor();
  /** Adds selector-scoped element/comment/text handlers. */
  on(selector: string, handlers: HTMLRewriterElementContentHandlers): this;
  /** Adds document-scoped handlers. */
  onDocument(handlers: HTMLRewriterDocumentContentHandlers): this;
  /** Returns a Response immediately; asynchronous handler failures error its body stream. */
  transform(response: Response): Response;
}

/** Exactly one supported wrapped module kind; CJS, text, data, JSON, and Python reject. */
type WorkerLoaderModuleObject =
  | {
    /** JavaScript source for an ES module; the legacy esModule spelling is unsupported. */
    js: string;
    /** A module cannot contain both JavaScript and WebAssembly. */
    wasm?: never;
  }
  | {
    /** Bytes for a WebAssembly module. */
    wasm: BufferSource;
    /** A module cannot contain both WebAssembly and JavaScript. */
    js?: never;
  };

/** Enforced per-invocation resource budgets for dynamically loaded Workers. */
interface WorkerLoaderLimits {
  /** CPU time in milliseconds; celld requires an unsigned 32-bit integer. */
  cpuMs?: number;
  /** Maximum subrequests; celld requires an unsigned 32-bit integer. */
  subRequests?: number;
}

/** Complete code-mode description for one dynamically loaded Worker. */
interface WorkerLoaderCode {
  /** Module-map key identifying the loaded Worker's main ES module. */
  mainModule: string;

  /** Sibling ES module sources and WebAssembly binaries, keyed by specifier. */
  modules: Record<string, string | BufferSource | WorkerLoaderModuleObject>;

  /** Cloudflare compatibility date used by the loaded isolate. */
  compatibilityDate?: string;

  /** Compatibility flags used by the loaded isolate. */
  compatibilityFlags?: string[];

  /**
   * Structured-clone values and Service Binding capabilities, including nested
   * Maps/Sets. Encoded values plus capability props are limited to 1 MiB;
   * arbitrary RPC targets, DO stubs, and functions cannot cross this boundary.
   */
  env?: Record<string, unknown>;

  /**
   * A Service Binding or loopback entrypoint brokering outgoing HTTP, or null
   * to disable ambient network access. Omission allows normal egress. A custom
   * broker cannot transport TCP or WebSockets; plain fetch-shaped objects are
   * not runtime capabilities and are rejected.
   */
  globalOutbound?: Fetcher | null;

  /** Default resource budgets for every invocation of this loaded Worker. */
  limits?: WorkerLoaderLimits;

  /**
   * Service Binding capabilities receiving one tail event after each fetch
   * invocation, including its logs and outcome. Plain fetch-shaped objects
   * are rejected. Delivery failure does not change the fetched response.
   */
  tails?: Fetcher[];
}

/** Properties supported by loaded Durable Object class capabilities. */
interface WorkerLoaderClassOptions {
  /** Structured-clone properties exposed as ctx.props, limited to 1 MiB. */
  props?: unknown;
}

/** Per-entrypoint properties and budgets applied to fetch and RPC invocations. */
interface WorkerLoaderEntrypointOptions extends WorkerLoaderClassOptions {
  /** Each budget is the lower of this value and the corresponding code limit. */
  limits?: WorkerLoaderLimits;
}

/** JavaScript base properties and the non-thenable sentinel owned by RPC proxies. */
// deno-lint-ignore ban-types -- This intentionally names Object.prototype's built-in members.
type CelldRpcProxyReserved =
  | keyof Object
  | "constructor"
  | "then"
  | "__proto__"
  | "__defineGetter__"
  | "__defineSetter__"
  | "__lookupGetter__"
  | "__lookupSetter__";

/**
 * Local DO-stub properties which do not dispatch application RPC. The deprecated
 * Fetcher helpers are conservatively reserved even when disabled by a flag.
 */
type CelldDurableObjectReserved =
  | keyof CelldDurableObjectStub
  | CelldRpcProxyReserved;

/** Lifecycle hooks, base state, and transport members unavailable as service RPC. */
type CelldRemoteReserved =
  | CelldRpcProxyReserved
  | keyof Fetcher
  | "connect"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError"
  | "dup"
  | "ctx"
  | "env";

/**
 * Public, string-keyed method-call projection shared by DOs, service bindings,
 * Dynamic Workers, and facets. Preserves arguments and nullable return values,
 * wraps synchronous returns, and flattens asynchronous returns into promises.
 *
 * The generic describes an expected API, not runtime validation. Non-function
 * fields and symbols are omitted. `Reserved` selects transport-specific names;
 * service bindings select entrypoint lifecycle restrictions, while DO stubs
 * select their narrower local-member filter to match celld's dispatch rules.
 * TypeScript cannot identify a function-valued own field versus a prototype
 * method. Property pipelines and capability transfer are intentionally untyped.
 */
type CelldRemoteMethods<
  T extends object,
  Reserved extends PropertyKey = never,
> = {
  [
    Key in keyof T as Key extends string ? Key extends Reserved ? never
      : T[Key] extends (...args: never[]) => unknown ? Key
      : never
      : never
  ]: T[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never;
};

/** Opaque capability minted only by WorkerLoaderStub.getDurableObjectClass(). */
interface DurableObjectClass<T extends object = object> {
  /** Type-only invariant brand; this field does not exist at runtime. */
  readonly __celldDurableObjectClass: (instance: T) => T;
}

/** Options lazily selecting a Dynamic Worker class for a persistent child object. */
interface FacetStartupOptions<T extends object = object> {
  /** Loaded class capability; regular DO namespaces and ctx.exports are invalid. */
  class: DurableObjectClass<T>;
  /** Identity presented to the child; omission inherits the parent's identity. */
  id?: DurableObjectId | string;
}

/**
 * Named child objects with isolated SQLite stores and the parent's durability.
 * Names are at most 256 UTF-8 bytes; depth including the root is at most four.
 * An uncommitted facet image blocks outbound effects from the child.
 */
interface DurableObjectFacets {
  /** Memoizes a lazy child stub until abort/delete or parent eviction. */
  get<T extends object = object>(
    name: string,
    getStartupOptions: () =>
      | FacetStartupOptions<T>
      | Promise<FacetStartupOptions<T>>,
  ): Fetcher & CelldRemoteMethods<T>;
  /** Resets a live child without removing its persisted SQLite contents. */
  abort(name: string, reason?: unknown): void;
  /** Starts deletion of a child's storage; the next get waits for completion. */
  delete(name: string): void;
}

/** Handle to one anonymous or memoized dynamically loaded Worker isolate. */
interface WorkerLoaderStub extends Disposable {
  /** Returns the default or named entrypoint as a Fetcher and RPC service. */
  getEntrypoint<T extends object = object>(
    name?: string | null,
    options?: WorkerLoaderEntrypointOptions | null,
  ): Fetcher & CelldRemoteMethods<T>;

  /** Returns an opaque loaded class capability for DurableObjectState.facets. */
  getDurableObjectClass<T extends object = object>(
    name?: string | null,
    options?: WorkerLoaderClassOptions | null,
  ): DurableObjectClass<T>;

  /** Drops the loaded isolate; anonymous stubs additionally have a GC backstop. */
  dispose(): void;

  /** Alias for `dispose()` used by explicit resource management. */
  [Symbol.dispose](): void;
}

/**
 * Dynamic Worker binding declared by worker_loaders. At most 256 live workers
 * share one process and at most 255 belong to one script generation. Code is
 * loaded lazily; allowExperimental is unsupported and rejects.
 */
interface WorkerLoader {
  /** Starts a new anonymous isolate from the supplied code description. */
  load(code: WorkerLoaderCode): WorkerLoaderStub;

  /** Lazily starts and memoizes one isolate under a caller-selected name. */
  get(
    name: string,
    getCode: () => WorkerLoaderCode | Promise<WorkerLoaderCode>,
  ): WorkerLoaderStub;
}

/** TCP peer address; strings use host:port, including bracketed IPv6 addresses. */
interface SocketAddress {
  /** Hostname or IP address to connect to. */
  hostname: string;
  /** Destination TCP port. */
  port: number;
}

/** Transport and half-close policy for an outbound socket. */
interface SocketOptions {
  /** Plain TCP, immediate TLS, or an explicit later startTls() upgrade. */
  secureTransport?: "off" | "on" | "starttls";
  /** Keeps the writable half open after EOF on the readable half. */
  allowHalfOpen?: boolean;
}

/** Peer information returned once a socket connects. */
interface SocketInfo {
  /** Remote address when the host supplies one. */
  remoteAddress?: string;
  /** Local address when the host supplies one. */
  localAddress?: string;
}

/** A TCP socket tied to its creating event, not a durable cross-event connection. */
interface Socket {
  /** Incoming bytes, without speculative reads before consumer demand. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Outgoing bytes; closing this stream shuts down the write half. */
  readonly writable: WritableStream<ArrayBuffer | ArrayBufferView>;
  /** Resolves with connection metadata; rejects if connection establishment fails. */
  readonly opened: Promise<SocketInfo>;
  /** Settles when the connection closes, rejecting for opening failures. */
  readonly closed: Promise<void>;
  /** Current transport mode (celld extension). */
  readonly secureTransport: "off" | "on" | "starttls";
  /** Closes both halves and settles the closed promise. */
  close(): Promise<void>;
  /** Consumes a starttls socket and returns a TLS socket; callable only once. */
  startTls(options?: {
    /** Server name checked against celld's bundled Mozilla root store. */
    expectedServerHostname?: string;
  }): Socket;
}

/** Outbound TCP/TLS; celld's network policy, not Cloudflare's port blocklist, applies. */
declare module "cloudflare:sockets" {
  /** Initiates a connection immediately and returns a handle before it opens. */
  export function connect(
    address: SocketAddress | string,
    options?: SocketOptions,
  ): Socket;
  /** Type-only socket handle; no Socket constructor is exported by the module. */
  export type Socket = globalThis.Socket;
  /** Type-only structured destination address. */
  export type SocketAddress = globalThis.SocketAddress;
  /** Type-only connection policy. */
  export type SocketOptions = globalThis.SocketOptions;
  /** Type-only metadata from a successful connection. */
  export type SocketInfo = globalThis.SocketInfo;
}

/** Process launch settings for the image configured on a Durable Object class. */
interface ContainerStartOptions {
  /** Overrides the image entrypoint and arguments. */
  entrypoint?: string[];
  /** Environment variables passed to the image. */
  env?: Record<string, string>;
  /** Allows fenced Internet egress, never the node's private/internal networks. */
  enableInternet?: boolean;
  /** Image-engine labels; names must be nonempty and contain no control characters. */
  labels?: Record<string, string>;
  /** Validated as positive but not enforced by celld 0.5.0. */
  hardTimeout?: number;
}

/** Settings for a command executed inside a running container. */
interface ContainerExecOptions {
  /** Additional command environment variables. */
  env?: Record<string, string>;
  /** Working directory inside the container. */
  cwd?: string;
  /** User identity understood by the container engine. */
  user?: string;
  /** Pipe exposed to the caller, a byte stream to pump, or omitted to close stdin. */
  stdin?: "pipe" | ReadableStream<ArrayBuffer | ArrayBufferView>;
  /** Capture stdout as a stream by default, or discard it. */
  stdout?: "pipe" | "ignore";
  /** Capture stderr by default; combined requires piped stdout and merges into it. */
  stderr?: "pipe" | "ignore" | "combined";
}

/** Buffered command results; ignored or combined output channels are empty buffers. */
interface ContainerExecOutput {
  /** Captured stdout bytes. */
  readonly stdout: ArrayBuffer;
  /** Captured stderr bytes. */
  readonly stderr: ArrayBuffer;
  /** Process exit status, including nonzero results without rejection. */
  readonly exitCode: number;
}

/** Running command whose I/O and completion cannot outlive its creating event. */
interface ContainerExecProcess {
  /** Process ID reported by the container engine. */
  readonly pid: number;
  /** Writable stdin only when the caller requested stdin: "pipe". */
  readonly stdin: WritableStream<ArrayBuffer | ArrayBufferView> | null;
  /** Streamed stdout, or null when ignored. */
  readonly stdout: ReadableStream<Uint8Array> | null;
  /** Streamed stderr, or null when ignored or combined with stdout. */
  readonly stderr: ReadableStream<Uint8Array> | null;
  /** Resolves to the command's exit status. */
  readonly exitCode: Promise<number>;
  /** Collects output once; rejects if either output stream is already locked. */
  output(): Promise<ContainerExecOutput>;
  /** Sends a numeric signal from 1 through 64; defaults to SIGTERM (15). */
  kill(signal?: number): void;
}

/** HTTP/TCP access to a container port, routed locally by the node. */
interface ContainerPort extends Fetcher {
  /** Connects to this port; address is ignored and immediate TLS is rejected. */
  connect(
    address?: SocketAddress | string,
    options?: SocketOptions & {
      /** Container TCP connections cannot request immediate TLS. */
      secureTransport?: "off" | "starttls";
    },
  ): Socket;
}

/**
 * Experimental container capability, available only as ctx.container on a
 * configured SQLite-backed Durable Object. Images run on the object's node;
 * disk is ephemeral after owner moves/resets. Monitor and exec settle only
 * within their creating event and do not keep an answered event active.
 * Inspection, snapshots, and outbound interception are deliberately untyped:
 * celld exposes placeholders that reject every call.
 */
interface Container {
  /** Live engine state, not a cached result of the previous monitor call. */
  readonly running: boolean;
  /** Starts asynchronously; start failures are reported by monitor(), not a returned promise. */
  start(options?: ContainerStartOptions): void;
  /** Waits for normal exit; rejects on failure, nonzero status, or destroy(error). */
  monitor(): Promise<void>;
  /** Stops and destroys the instance, optionally rejecting monitor with a reason. */
  destroy(error?: unknown): Promise<void>;
  /** Sends a numeric signal from 1 through 64 to a running container. */
  signal(signal: number): void;
  /** Obtains a route for port 1–65535; macOS requires the image to EXPOSE it. */
  getTcpPort(port: number): ContainerPort;
  /** Configures a positive idle lifetime in milliseconds; the host resolves to an empty string. */
  setInactivityTimeout(durationMs: number): Promise<string>;
  /** Starts a nonempty command in the running container. */
  exec(
    command: string[],
    options?: ContainerExecOptions,
  ): Promise<ContainerExecProcess>;
}

/** Asynchronous invocation signature of a callable RPC capability. */
type CelldRpcCallable<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => CelldRpcPromise<Result>
  : unknown;

/** String-keyed RPC properties; symbols and the transport's reserved names are not forwarded. */
type CelldRpcProperties<T> = T extends object ? {
    [
      Key in keyof T as Key extends string
        ? Exclude<Key, "then" | "catch" | "finally" | "dup">
        : never
    ]: CelldRpcPromise<T[Key]>;
  }
  : unknown;

/**
 * Awaitable/pipelined same-isolate RPC result. Intermediate properties can be
 * read or called before awaiting the root; Dynamic Workers deliberately use
 * the narrower CelldRemoteMethods surface because that transport cannot do this.
 */
type CelldRpcPromise<T> =
  & Promise<Awaited<T>>
  & CelldRpcProperties<Awaited<T>>
  & CelldRpcCallable<Awaited<T>>;

/** Disposable same-isolate RPC capability with asynchronously projected members. */
type CelldRpcStub<T extends object> =
  & CelldRpcProperties<T>
  & CelldRpcCallable<T>
  & {
    /** Creates an independently disposable handle to the same target. */
    dup(): CelldRpcStub<T>;
    /** Releases the handle and eventually disposes an unreferenced target. */
    [Symbol.dispose](): void;
  };

/** celld's implementation of the Cloudflare Workers module API. */
declare module "cloudflare:workers" {
  /** Base class that initializes `ctx` and `env` for a Durable Object. */
  export class DurableObject<
    Env = unknown,
    Exports extends object = Record<string, unknown>,
    Props = unknown,
  > {
    /** Runtime context for the active Durable Object. */
    protected readonly ctx: DurableObjectState<Exports, Props>;

    /** Environment bindings supplied to this Worker deployment. */
    protected readonly env: Env;

    /** Initializes the standard Durable Object base fields. */
    constructor(ctx: DurableObjectState<Exports, Props>, env: Env);
  }

  /** Base class for a named or default class-based Worker entrypoint. */
  export class WorkerEntrypoint<
    Env = unknown,
    Exports extends object = Record<string, unknown>,
    Props = unknown,
  > {
    /** Per-request execution context, loopback exports, and stub properties. */
    protected readonly ctx: ExecutionContext<Exports, Props>;

    /** Environment bindings supplied to this Worker deployment. */
    protected readonly env: Env;

    /** Initializes the standard Worker entrypoint base fields. */
    constructor(ctx: ExecutionContext<Exports, Props>, env: Env);
  }

  /**
   * Base class for a durable, replay-driven Workflow export. celld reruns
   * `run` on resume; put side effects in idempotent `step.do` callbacks.
   */
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    /** Workflows receive only background-work and compatibility fallback hooks. */
    protected readonly ctx: WorkflowExecutionContext;

    /** Bindings from the script declaring this Workflow. */
    protected readonly env: Env;

    /** Initializes the Workflow's per-replay execution context and bindings. */
    constructor(ctx: WorkflowExecutionContext, env: Env);

    /** Replays the orchestration body, reusing successful durable step results. */
    abstract run(
      event: WorkflowEvent<Params>,
      step: WorkflowStep,
    ): Promise<unknown>;
  }

  /** Type-only creation event; this name is not a runtime export. */
  export type WorkflowEvent<Params = unknown> = globalThis.WorkflowEvent<
    Params
  >;

  /** Type-only durable step API; this name is not a runtime export. */
  export type WorkflowStep = globalThis.WorkflowStep;

  /** Type-only step policy; this name is not a runtime export. */
  export type WorkflowStepConfig = globalThis.WorkflowStepConfig;

  /** Type-only callback context; this name is not a runtime export. */
  export type WorkflowStepContext = globalThis.WorkflowStepContext;

  /** Base class whose instances cross same-isolate RPC calls as capability stubs. */
  export class RpcTarget {}

  /** Explicit same-isolate RPC capability wrapping an object or function. */
  export type RpcStub<T extends object = object> = CelldRpcStub<T>;

  /** Runtime constructor that returns a projected proxy, not a synchronous copy of its target. */
  export const RpcStub: {
    /** Prototype exposed for instanceof checks. */
    readonly prototype: object;
    /** Wraps a local object or function with asynchronous methods/properties and disposal. */
    new <T extends object>(target: T): RpcStub<T>;
  };

  /** Promise-like root node returned by celld's pipelined RPC implementation. */
  export class RpcPromise<T> extends Promise<T> {}

  /** Awaitable and callable property-path node used for RPC promise pipelining. */
  export class RpcProperty {}

  /** Runtime brand used by service-binding and loopback entrypoint stubs. */
  export class ServiceStub {}

  /** Registers background work with the currently executing Worker event. */
  export function waitUntil(promise: Promise<unknown>): void;

  /** Environment bindings for the currently loaded Worker. */
  export const env: Record<string, unknown>;

  /** Loopback stubs for entrypoints and namespaces exported by this Worker. */
  const workerExports: Record<string, unknown>;

  /** Module-level spelling of the current Worker's loopback export surface. */
  export { workerExports as exports };
}

/** Values accepted by celld's D1 bind encoder. */
type D1Bindable =
  | string
  | number
  | boolean
  | null
  | number[]
  | ArrayBuffer
  | ArrayBufferView;

/** Values returned across celld's D1 JSON boundary; BLOBs are byte arrays. */
type D1Value = string | number | null | number[];

/** One object-shaped row returned by D1. */
type D1Row = Record<string, D1Value>;

/** Execution metadata attached to every successful D1 statement result. */
interface D1Meta {
  /** Statement duration in milliseconds. */
  duration: number;

  /** Approximate number of rows read by the SQLite query plan. */
  rows_read: number;

  /** Number of rows written by the statement. */
  rows_written: number;

  /** SQLite row ID produced by the most recent insert. */
  last_row_id: number;

  /** Number of rows changed by the statement. */
  changes: number;

  /** Whether the statement changed database contents. */
  changed_db: boolean;

  /** SQLite database file size in bytes after execution. */
  size_after: number;

  /** Runtime that served this D1 request. */
  served_by: "celld";

  /** celld has no regional read replicas and reports the local region. */
  served_by_region: "local";

  /** celld always serves D1 operations from the database's primary cell. */
  served_by_primary: true;
}

/** Successful D1 query or mutation result. */
interface D1Result<Row extends D1Row = D1Row> {
  /** Success discriminator; failures reject instead of returning this object. */
  success: true;

  /** SQLite execution statistics and serving metadata. */
  meta: D1Meta;

  /** Rows returned by the statement, or an empty array for no result set. */
  results: Row[];
}

/** Aggregate result from executing a string containing one or more SQL statements. */
interface D1ExecResult {
  /** Number of complete SQL statements executed. */
  count: number;

  /** Total execution duration in milliseconds. */
  duration: number;
}

/** Reusable D1 SQL statement with optional positional bindings. */
interface D1PreparedStatement<Row extends D1Row = D1Row> {
  /** Returns a statement carrying the supplied positional bind values. */
  bind(...values: D1Bindable[]): D1PreparedStatement<Row>;

  /** Executes the statement and returns all object-shaped rows plus metadata. */
  all(): Promise<D1Result<Row>>;

  /** Executes a mutation or query and returns its standard D1 result. */
  run(): Promise<D1Result<Row>>;

  /** Returns the first object-shaped row, or `null` for an empty result. */
  first(): Promise<Row | null>;

  /** Returns one column from the first row and rejects when the column is absent. */
  first<Column extends keyof Row & string>(
    column: Column,
  ): Promise<Row[Column] | null>;

  /** Returns positional rows without a leading column-name row. */
  raw(options?: { columnNames?: false }): Promise<D1Value[][]>;

  /** Returns column names followed by positional result rows. */
  raw(options: {
    /** Requests a leading row containing column names. */
    columnNames: true;
  }): Promise<[string[], ...D1Value[][]]>;
}

/** Primary-only D1 session used for sequential queries and transactional batches. */
interface D1DatabaseSession {
  /** Creates a prepared statement associated with this session. */
  prepare<Row extends D1Row = D1Row>(sql: string): D1PreparedStatement<Row>;

  /** Executes every statement in one transaction and rolls back on failure. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;

  /** Returns celld's opaque bookmark for the primary session, if available. */
  getBookmark(): string | null;
}

/**
 * D1 binding backed by one replicated celld SQLite cell and one writer.
 * Binding results are limited to 100,000 rows or 32 MiB; invalid
 * UTF-8 SQLite TEXT is rejected, so arbitrary bytes must be stored as BLOBs.
 */
interface D1Database {
  /** Creates a reusable SQL statement for this database. */
  prepare<Row extends D1Row = D1Row>(sql: string): D1PreparedStatement<Row>;

  /** Executes a multi-statement SQL string in one transaction. */
  exec(sql: string): Promise<D1ExecResult>;

  /** Executes every prepared statement in one transaction and rolls back on failure. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;

  /**
   * Creates a primary-only session.
   *
   * celld accepts Cloudflare consistency constraints and opaque bookmarks,
   * but has no read replicas, so every session is served by the primary.
   */
  withSession(
    constraintOrBookmark?: "first-primary" | "first-unconstrained" | string,
  ): D1DatabaseSession;

  /**
   * Compatibility placeholder for Cloudflare's database dump operation.
   * celld currently rejects every call because the SQLite file lives in the
   * operator's own fleet bucket.
   */
  dump(): Promise<ArrayBuffer>;
}

/** Decoders accepted by a KV read. */
type KVReadType = "text" | "json" | "arrayBuffer" | "stream";

/** KV read options; celld reads from the namespace rather than an edge cache. */
type KVGetOptions<Type extends KVReadType = KVReadType> =
  & {
    /** Accepted for compatibility but has no effect in celld. */
    cacheTtl?: number;
  }
  & (Type extends "text" ? {
      /** Value decoder; omission means UTF-8 text. */
      type?: Type;
    }
    : {
      /** Non-text decoders must be selected explicitly. */
      type: Type;
    });

/** A decoded KV value and its JSON metadata; both are null for a missing key. */
interface KVValueWithMetadata<Value, Metadata> {
  /** Decoded value, or null when absent or expired. */
  value: Value | null;
  /** JSON metadata, or null when absent. */
  metadata: Metadata | null;
}

/** Single-key metadata reads additionally report celld's lack of an edge cache. */
interface KVGetWithMetadataResult<Value, Metadata>
  extends KVValueWithMetadata<Value, Metadata> {
  /** Always null; celld does not have an edge cache. */
  cacheStatus: null;
}

/** Expiration and JSON metadata associated with a KV write. */
interface KVPutOptions {
  /** Absolute expiration in Unix seconds. */
  expiration?: number;
  /** Relative expiration in seconds; takes precedence over expiration. */
  expirationTtl?: number;
  /** JSON-serializable user metadata. */
  metadata?: unknown;
}

/** Prefix and pagination parameters for a KV listing. */
interface KVListOptions {
  /** Only include keys starting with this prefix. */
  prefix?: string;
  /** Maximum page size, from 1 through 1,000; defaults to 1,000. */
  limit?: number;
  /** Opaque continuation token returned by a previous page. */
  cursor?: string;
}

/** One key returned by KV list; the value is not loaded. */
interface KVKey<Metadata = unknown> {
  /** Key within the namespace. */
  name: string;
  /** Optional expiration in Unix seconds. */
  expiration?: number;
  /** User metadata, omitted when no metadata was written. */
  metadata?: Metadata;
}

/** A KV listing page; a cursor exists only when more keys remain. */
type KVListResult<Metadata = unknown> =
  & {
    /** Keys and their stored metadata. */
    keys: KVKey<Metadata>[];
    /** Always null because there is no edge cache. */
    cacheStatus: null;
  }
  & (
    | {
      /** No more keys match this listing. */
      list_complete: true;
    }
    | {
      /** Another page may contain matching keys. */
      list_complete: false;
      /** Pass to list to continue. */
      cursor: string;
    }
  );

/**
 * KV binding backed by a single-writer namespace cell. Values over 1 MiB
 * require a fleet bucket; cacheTtl is ignored. Bulk reads accept at most
 * 100 keys. Streamed writes are buffered up to the 25 MiB value limit;
 * unlike R2.put, celld's KV.put does not accept Blobs.
 */
interface KVNamespace {
  /** Reads UTF-8 text, or null when the key is absent or expired. */
  get(
    key: string,
    options?: "text" | KVGetOptions<"text">,
  ): Promise<string | null>;
  /** Parses a JSON value; the type parameter does not validate stored data. */
  get<Value = unknown>(
    key: string,
    options: "json" | KVGetOptions<"json">,
  ): Promise<Value | null>;
  /** Reads the value as a byte buffer. */
  get(
    key: string,
    options: "arrayBuffer" | KVGetOptions<"arrayBuffer">,
  ): Promise<ArrayBuffer | null>;
  /** Reads the value as a byte stream. */
  get(
    key: string,
    options: "stream" | KVGetOptions<"stream">,
  ): Promise<ReadableStream<Uint8Array> | null>;
  /** Reads text for up to 100 keys, including null entries for missing keys. */
  get(
    keys: string[],
    options?: "text" | KVGetOptions<"text">,
  ): Promise<Map<string, string | null>>;
  /** Bulk-decodes JSON values. */
  get<Value = unknown>(
    keys: string[],
    options: "json" | KVGetOptions<"json">,
  ): Promise<Map<string, Value | null>>;
  /** Bulk-reads byte buffers; supported by celld's shared read decoder. */
  get(
    keys: string[],
    options: "arrayBuffer" | KVGetOptions<"arrayBuffer">,
  ): Promise<Map<string, ArrayBuffer | null>>;
  /** Bulk-reads streams; supported by celld's shared read decoder. */
  get(
    keys: string[],
    options: "stream" | KVGetOptions<"stream">,
  ): Promise<Map<string, ReadableStream<Uint8Array> | null>>;

  /** Reads text and JSON metadata for one key. */
  getWithMetadata<Metadata = unknown>(
    key: string,
    options?: "text" | KVGetOptions<"text">,
  ): Promise<KVGetWithMetadataResult<string, Metadata>>;
  /** Reads a typed JSON value and its metadata. */
  getWithMetadata<Value = unknown, Metadata = unknown>(
    key: string,
    options: "json" | KVGetOptions<"json">,
  ): Promise<KVGetWithMetadataResult<Value, Metadata>>;
  /** Reads a byte buffer and metadata. */
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: "arrayBuffer" | KVGetOptions<"arrayBuffer">,
  ): Promise<KVGetWithMetadataResult<ArrayBuffer, Metadata>>;
  /** Reads a byte stream and metadata. */
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: "stream" | KVGetOptions<"stream">,
  ): Promise<KVGetWithMetadataResult<ReadableStream<Uint8Array>, Metadata>>;
  /** Bulk-reads text and metadata; bulk entries do not have cacheStatus. */
  getWithMetadata<Metadata = unknown>(
    keys: string[],
    options?: "text" | KVGetOptions<"text">,
  ): Promise<Map<string, KVValueWithMetadata<string, Metadata>>>;
  /** Bulk-reads JSON values and metadata. */
  getWithMetadata<Value = unknown, Metadata = unknown>(
    keys: string[],
    options: "json" | KVGetOptions<"json">,
  ): Promise<Map<string, KVValueWithMetadata<Value, Metadata>>>;
  /** Bulk-reads byte buffers and metadata. */
  getWithMetadata<Metadata = unknown>(
    keys: string[],
    options: "arrayBuffer" | KVGetOptions<"arrayBuffer">,
  ): Promise<Map<string, KVValueWithMetadata<ArrayBuffer, Metadata>>>;
  /** Bulk-reads byte streams and metadata. */
  getWithMetadata<Metadata = unknown>(
    keys: string[],
    options: "stream" | KVGetOptions<"stream">,
  ): Promise<
    Map<string, KVValueWithMetadata<ReadableStream<Uint8Array>, Metadata>>
  >;

  /** Stores text, bytes, or a fully consumed byte stream, with optional expiration and JSON metadata. */
  put(
    key: string,
    value:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | ReadableStream<ArrayBuffer | ArrayBufferView>,
    options?: KVPutOptions,
  ): Promise<void>;
  /** Deletes one key; missing keys are harmless. */
  delete(key: string): Promise<void>;
  /** Deletes one key or up to 100 keys in celld's bulk-delete extension. */
  deleteBulk(keys: string | string[]): Promise<void>;
  /** Lists non-expired keys, their metadata, and a continuation cursor. */
  list<Metadata = unknown>(
    options?: KVListOptions,
  ): Promise<KVListResult<Metadata>>;
}

/** Queue body codecs; v8 uses structured cloning, while modern dates default to json. */
type QueueContentType = "text" | "bytes" | "json" | "v8";

/** Per-message producer overrides. */
interface QueueSendOptions {
  /** Body codec; defaults to json since 2024-03-18, otherwise v8 (flags override). */
  contentType?: QueueContentType;
  /** Delivery delay in seconds, from 0 through 86,400. */
  delaySeconds?: number;
}

/** A body and optional codec/delay for a producer batch. */
interface MessageSendRequest<Body = unknown> extends QueueSendOptions {
  /** Body encoded using contentType, or the compatibility-selected default. */
  body: Body;
}

/** Producer batch-wide defaults; an individual message delay takes precedence. */
interface QueueSendBatchOptions {
  /** Default delivery delay in seconds, from 0 through 86,400. */
  delaySeconds?: number;
}

/** Queue backlog snapshot exposed by celld to producers and consumers. */
interface QueueMetrics {
  /** Number of retained messages in the backlog. */
  backlogCount: number;
  /** Total encoded body bytes in the backlog. */
  backlogBytes: number;
  /** Creation time of the oldest message; undefined for an empty queue. */
  oldestMessageTimestamp?: Date;
}

/** Metadata returned by a successful celld producer operation. */
interface QueueSendResponse {
  /** celld's post-send queue snapshot. */
  metadata: {
    /** Backlog counts, bytes, and oldest timestamp. */
    metrics: QueueMetrics;
  };
}

/**
 * Push Queue producer binding. A queue has one writer and one consumer script;
 * messages are retained for four days. Producers must tolerate overload errors.
 */
interface Queue<Body = unknown> {
  /** Enqueues a message and returns celld's backlog metadata, not void. */
  send(body: Body, options?: QueueSendOptions): Promise<QueueSendResponse>;
  /** Enqueues an iterable containing at most 100 messages. */
  sendBatch(
    messages: Iterable<MessageSendRequest<Body>>,
    options?: QueueSendBatchOptions,
  ): Promise<QueueSendResponse>;
  /** Reads the queue backlog snapshot without sending a message (celld extension). */
  metrics(): Promise<QueueMetrics>;
}

/** Retry delay accepted by consumer settlement methods. */
interface QueueRetryOptions {
  /** Delay in seconds; -1 selects the queue's configured/default delay. */
  delaySeconds?: number;
}

/** One decoded push message; settlement methods are valid only during dispatch. */
interface Message<Body = unknown> {
  /** Stable message identifier. */
  readonly id: string;
  /** Time the message was enqueued. */
  readonly timestamp: Date;
  /** Decoded message body; consumers are responsible for validating it. */
  readonly body: Body;
  /** Delivery attempt count, starting at one. */
  readonly attempts: number;
  /** Acknowledges this message unless an earlier settlement takes precedence. */
  ack(): void;
  /** Requests redelivery unless already acknowledged. */
  retry(options?: QueueRetryOptions): void;
}

/** A consumer batch, including celld's backlog metadata extension. */
interface MessageBatch<Body = unknown> {
  /** Name of the queue delivering the batch. */
  readonly queue: string;
  /** Decoded messages leased to this invocation. */
  readonly messages: readonly Message<Body>[];
  /** Backlog snapshot at delivery. */
  readonly metadata: QueueSendResponse["metadata"];
  /** Acknowledges the batch unless retryAll was already requested. */
  ackAll(): void;
  /** Requests redelivery of unacknowledged messages unless ackAll already won. */
  retryAll(options?: QueueRetryOptions): void;
}

/** R2 object storage classes understood by celld's fleet-bucket adapter. */
type R2StorageClass = "Standard" | "InfrequentAccess";

/** HTTP response metadata stored alongside an R2 object. */
interface R2HTTPMetadata {
  /** MIME type. */
  contentType?: string;
  /** Language tag. */
  contentLanguage?: string;
  /** Inline/attachment disposition and optional filename. */
  contentDisposition?: string;
  /** Applied content encoding. */
  contentEncoding?: string;
  /** Cache-Control header value. */
  cacheControl?: string;
  /** Expires header timestamp. */
  cacheExpiry?: Date;
}

/** Preconditions accepted by R2 reads and writes, alternatively supplied as Headers. */
interface R2Conditional {
  /** Required entity tag, or * to require an existing object. */
  etagMatches?: string;
  /** Excluded entity tag, or * to require an absent object. */
  etagDoesNotMatch?: string;
  /** Require an upload newer than this time. */
  uploadedAfter?: Date;
  /** Require an upload older than this time. */
  uploadedBefore?: Date;
}

/** A byte range selected by offset/length or by a suffix byte count. */
type R2Range =
  | {
    /** First byte offset, defaulting to zero. */
    offset?: number;
    /** Number of bytes; omission reads to the end. */
    length?: number;
    /** Suffix ranges cannot be combined with offset/length. */
    suffix?: never;
  }
  | {
    /** Number of bytes to read from the end of the object. */
    suffix: number;
    /** Suffix ranges do not specify an offset. */
    offset?: never;
    /** Suffix ranges do not specify a separate length. */
    length?: never;
  };

/** Digest algorithms stored with R2 objects. */
type R2ChecksumAlgorithm = "md5" | "sha1" | "sha256" | "sha384" | "sha512";

/** Available digests as bytes, with a JSON encoder that returns hexadecimal strings. */
type R2Checksums = Partial<Record<R2ChecksumAlgorithm, ArrayBuffer>> & {
  /** Encodes each available digest in hexadecimal. */
  toJSON(): Partial<Record<R2ChecksumAlgorithm, string>>;
};

/** R2 object metadata; head/list and failed conditional reads do not include a body. */
interface R2Object {
  /** Key relative to this bucket binding. */
  readonly key: string;
  /** Opaque object version. */
  readonly version: string;
  /** Full object size in bytes. */
  readonly size: number;
  /** Unquoted entity tag. */
  readonly etag: string;
  /** Quoted entity tag suitable for an HTTP ETag header. */
  readonly httpEtag: string;
  /** Time of the upload. */
  readonly uploaded: Date;
  /** HTTP metadata; an empty object if not included in a listing. */
  readonly httpMetadata: R2HTTPMetadata;
  /** User metadata; an empty object if not included in a listing. */
  readonly customMetadata: Record<string, string>;
  /** Available content digests. */
  readonly checksums: R2Checksums;
  /** Storage class reported by the adapter. */
  readonly storageClass: R2StorageClass;
  /** Selected byte range, present for ranged reads. */
  readonly range?: R2Range;
  /** Copies stored HTTP metadata into mutable response headers. */
  writeHttpMetadata(headers: Headers): void;
}

/** An R2 object with a single-consumption response body. */
interface R2ObjectBody extends R2Object {
  /** Stream of object bytes. */
  readonly body: ReadableStream<Uint8Array>;
  /** Whether the body has been consumed or disturbed. */
  readonly bodyUsed: boolean;
  /** Consumes the body into a byte buffer. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Consumes the body into a typed byte array. */
  bytes(): Promise<Uint8Array>;
  /** Consumes and decodes the body as UTF-8. */
  text(): Promise<string>;
  /** Consumes and parses JSON; the type parameter does not validate data. */
  json<Value = unknown>(): Promise<Value>;
  /** Consumes the body into a Blob. */
  blob(): Promise<Blob>;
}

/** R2 read options. Customer-provided encryption keys are unsupported. */
interface R2GetOptions {
  /** Preconditions; failure returns metadata without a body. */
  onlyIf?: R2Conditional | Headers;
  /** Byte range, or Headers containing a single Range header. */
  range?: R2Range | Headers;
}

/** Metadata options shared by regular and multipart R2 uploads. */
interface R2MultipartOptions {
  /** HTTP metadata, either a structured object or response Headers. */
  httpMetadata?: R2HTTPMetadata | Headers;
  /** User-defined metadata stored with the object. */
  customMetadata?: Record<string, string>;
  /** Requested storage class. */
  storageClass?: R2StorageClass;
}

/** Regular R2 writes additionally accept conditions and checksum verification. */
type R2PutOptions =
  & R2MultipartOptions
  & Partial<Record<R2ChecksumAlgorithm, string | ArrayBuffer | ArrayBufferView>>
  & {
    /** Preconditions; failure returns null without replacing the object. */
    onlyIf?: R2Conditional | Headers;
  };

/** Bodies accepted by R2.put and multipart uploadPart; null/undefined mean empty. */
type R2PutValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream<Uint8Array>
  | null
  | undefined;

/** Prefix and page controls for an R2 listing. */
interface R2ListOptions {
  /** Maximum number of objects, from 1 through 1,000. */
  limit?: number;
  /** Restricts results to keys with this prefix. */
  prefix?: string;
  /** Opaque continuation token from a prior result. */
  cursor?: string;
  /** Starts after this key, excluding the key itself. */
  startAfter?: string;
  /** Groups keys into delimitedPrefixes, commonly using /. */
  delimiter?: string;
  /** Metadata categories to include alongside ordinary object fields. */
  include?: ("httpMetadata" | "customMetadata")[];
}

/** One R2 listing page, with a cursor only when truncated. */
type R2Objects =
  & {
    /** Object metadata, without bodies. */
    objects: R2Object[];
    /** Common prefixes grouped by the requested delimiter. */
    delimitedPrefixes: string[];
  }
  & (
    | {
      /** This page exhausted the matching keys. */
      truncated: false;
    }
    | {
      /** Another page remains. */
      truncated: true;
      /** Continuation token for the next list request. */
      cursor: string;
    }
  );

/** Part descriptor returned by uploadPart and passed to complete. */
interface R2UploadedPart {
  /** One-based part number. */
  partNumber: number;
  /** Part entity tag; celld currently returns an empty string. */
  etag: string;
}

/**
 * Node-local multipart upload handle. It cannot survive a restart or move to
 * another node. Stored parts cannot be replaced or reordered at completion;
 * out-of-order parts are buffered subject to a 256 MiB cap.
 */
interface R2MultipartUpload {
  /** Destination object key. */
  readonly key: string;
  /** Opaque upload identifier. */
  readonly uploadId: string;
  /** Uploads one part and returns its completion descriptor. */
  uploadPart(partNumber: number, value: R2PutValue): Promise<R2UploadedPart>;
  /** Completes the upload using the ordered part descriptors. */
  complete(uploadedParts: R2UploadedPart[]): Promise<R2Object>;
  /** Abandons the upload and releases its pending parts. */
  abort(): Promise<void>;
}

/**
 * R2 binding stored under r2/<bucket_name>/ in the fleet bucket. No jurisdiction
 * or ssecKey support. Conditional streamed writes are limited to 8 MiB.
 */
interface R2Bucket {
  /** Reads metadata without a body, or null if absent. */
  head(key: string): Promise<R2Object | null>;
  /** Reads a body when no conditional is supplied, or null if absent. */
  get(
    key: string,
    options?: R2GetOptions & { onlyIf?: undefined },
  ): Promise<R2ObjectBody | null>;
  /** Conditional reads can return metadata without a body; narrow using "body" in result. */
  get(
    key: string,
    options: R2GetOptions,
  ): Promise<R2ObjectBody | R2Object | null>;
  /** Writes an unconditional object and returns its metadata. */
  put(
    key: string,
    value: R2PutValue,
    options?: R2PutOptions & { onlyIf?: undefined },
  ): Promise<R2Object>;
  /** Writes an object, returning null when preconditions fail. */
  put(
    key: string,
    value: R2PutValue,
    options: R2PutOptions,
  ): Promise<R2Object | null>;
  /** Deletes one key or up to 1,000 keys; absent keys are harmless. */
  delete(keys: string | string[]): Promise<void>;
  /** Lists object metadata and optional delimiter groups. */
  list(options?: R2ListOptions): Promise<R2Objects>;
  /** Creates a node-local multipart upload; conditions and checksums are unsupported. */
  createMultipartUpload(
    key: string,
    options?: R2MultipartOptions,
  ): Promise<R2MultipartUpload>;
  /** Reopens a handle synchronously; an unknown upload rejects on its first operation. */
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

/** Milliseconds or a duration such as "2 seconds"; months/years mean 30/365 days. */
type WorkflowDuration =
  | number
  | `${number} ${
    | "second"
    | "minute"
    | "hour"
    | "day"
    | "week"
    | "month"
    | "year"}${"" | "s"}`;

/** Workflows get only these context hooks, not a cell's storage or Worker RPC context. */
type WorkflowExecutionContext = Pick<
  ExecutionContext,
  "waitUntil" | "passThroughOnException"
>;

/** Immutable creation event passed to WorkflowEntrypoint.run on every replay. */
interface WorkflowEvent<Params = unknown> {
  /** Structured-cloned creation parameters, limited to 1 MiB. */
  readonly payload: Params;
  /** Original creation time, stable across replays. */
  readonly timestamp: Date;
  /** Application-supplied or generated instance identifier. */
  readonly instanceId: string;
  /** Configured Workflow name (celld extension). */
  readonly workflowName: string;
}

/** Retry policy for a durable step. */
interface WorkflowStepRetries {
  /** Maximum retries after the first attempt, up to 10,000. */
  limit: number;
  /** Fixed delay or a callback computing the base delay after a failure. */
  delay:
    | WorkflowDuration
    | ((info: {
      /** Context of the failed attempt. */
      ctx: WorkflowStepContext;
      /** Error thrown by that attempt. */
      error: unknown;
    }) => WorkflowDuration | Promise<WorkflowDuration>);
  /** Backoff multiplier; defaults to constant when retries is supplied. */
  backoff?: "constant" | "linear" | "exponential";
}

/** Supported durable step options; sensitive output and rollback are not implemented. */
interface WorkflowStepConfig {
  /** Overrides the default five retries with exponential 10-second base delay. */
  retries?: WorkflowStepRetries;
  /** Positive per-attempt deadline; defaults to ten minutes. */
  timeout?: WorkflowDuration;
}

/** Context passed to each step callback and dynamic retry delay callback. */
interface WorkflowStepContext {
  /** Name and occurrence distinguish repeated steps during deterministic replay. */
  step: {
    /** User-selected step name. */
    name: string;
    /** One-based occurrence of this name during this replay. */
    count: number;
  };
  /** One-based attempt counter. */
  attempt: number;
  /** Effective policy; a dynamic delay function is omitted from this snapshot. */
  config: {
    /** Resolved retry policy, without any dynamic callback. */
    retries: Omit<WorkflowStepRetries, "delay"> & {
      /** Fixed delay when supplied; absent for dynamic delays. */
      delay?: WorkflowDuration;
    };
    /** Effective per-attempt timeout. */
    timeout: WorkflowDuration;
  };
}

/** An externally sent event durably consumed by waitForEvent. */
interface WorkflowStepEvent<Payload = unknown> {
  /** Structured-cloned event data. */
  payload: Payload;
  /** Time the event was received. */
  timestamp: Date;
  /** Event type matched by the waiting step. */
  type: string;
}

/** Event selection and deadline for a durable wait. */
interface WorkflowWaitForEventOptions {
  /** Event type, up to 100 letters, digits, hyphens, or underscores. */
  type: string;
  /** From one second to 365 days; defaults to 24 hours. */
  timeout?: WorkflowDuration;
}

/**
 * Durable replay primitives supplied to a Workflow run. Step callbacks cannot
 * invoke these methods recursively. Results must be structured-cloneable, not
 * streams, and fit within 1 MiB. Side effects can repeat after a crash.
 */
interface WorkflowStep {
  /** Memoizes a successful callback result using the default retry policy. */
  do<Result>(
    name: string,
    callback: (ctx: WorkflowStepContext) => Result | Promise<Result>,
  ): Promise<Result>;
  /** Memoizes a callback result with explicit retries and/or timeout. */
  do<Result>(
    name: string,
    config: WorkflowStepConfig,
    callback: (ctx: WorkflowStepContext) => Result | Promise<Result>,
  ): Promise<Result>;
  /** Suspends for up to 365 days using a persisted deadline. */
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  /** Suspends until a future Date or Unix timestamp in milliseconds, up to 365 days away. */
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  /** Consumes the next matching buffered event, rejecting if the deadline expires. */
  waitForEvent<Payload = unknown>(
    name: string,
    options: WorkflowWaitForEventOptions,
  ): Promise<WorkflowStepEvent<Payload>>;
}

/** Separate terminal retention policies; omitted members default to 30 days. */
interface WorkflowRetentionOptions {
  /** Retention after success, from zero through 30 days. */
  successRetention?: WorkflowDuration;
  /** Retention after failure or termination, from zero through 30 days. */
  errorRetention?: WorkflowDuration;
}

/** Accepted placement hints; celld still uses fleet ownership to choose the actual node. */
type WorkflowLocationHint =
  | "wnam"
  | "enam"
  | "sam"
  | "weur"
  | "eeur"
  | "apac"
  | "apac-ne"
  | "apac-se"
  | "oc"
  | "afr"
  | "me";

/** Parameters, retention, and advisory placement for creating a Workflow instance. */
interface WorkflowInstanceCreateOptions<Params = unknown> {
  /** Optional ID, 1–100 letters/digits/hyphens/underscores, not beginning with a hyphen. */
  id?: string;
  /** Structured-cloneable parameters, limited to 1 MiB. */
  params?: Params;
  /** Terminal ledger retention; each duration is capped at 30 days. */
  retention?: WorkflowRetentionOptions;
  /** Validated Cloudflare placement hint, not an enforced celld region. */
  locationHint?: WorkflowLocationHint;
}

/** Event to deliver to an existing Workflow instance. */
interface WorkflowInstanceEvent<Payload = unknown> {
  /** Type matched by waitForEvent. */
  type: string;
  /** Structured-cloneable payload, limited to 1 MiB. */
  payload?: Payload;
}

/** Optional execution-history selector for a new Workflow generation. */
interface WorkflowInstanceRestartOptions {
  /** Reuses earlier results, then reruns this step and everything after it. */
  from?: {
    /** Name of an existing step in execution history. */
    name: string;
    /** One-based occurrence of that name; defaults to one. */
    count?: number;
    /** History category; defaults to do (sleepUntil also uses sleep). */
    type?: "do" | "sleep" | "waitForEvent";
  };
}

/** Observable lifecycle states emitted by celld's Workflow ledger. */
type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "waiting"
  | "waitingForPause"
  | "paused"
  | "complete"
  | "errored"
  | "terminated";

/** Durable status snapshot of an instance, including its terminal output or error. */
interface WorkflowInstanceStatusResult<Output = unknown> {
  /** Current lifecycle state. */
  status: WorkflowInstanceStatus;
  /** Always null: rollback is not implemented. */
  rollback: null;
  /** Final run result, present when the completed run returned a value. */
  output?: Output;
  /** Serialized terminal failure. */
  error?: {
    /** Error class/name. */
    name: string;
    /** Human-readable failure message. */
    message: string;
  };
}

/** Durable handle to an existing Workflow instance. */
interface WorkflowInstance<Output = unknown> {
  /** Stable instance identifier. */
  readonly id: string;
  /** Fetches durable status; a nonexistent instance rejects. */
  status(): Promise<WorkflowInstanceStatusResult<Output>>;
  /** Terminates the instance; rollback cannot be requested. */
  terminate(options?: {
    /** Only false is accepted; rollback execution is not implemented. */
    rollback?: false;
  }): Promise<void>;
  /** Buffers an event until a matching wait consumes it. */
  sendEvent<Payload = unknown>(
    options: WorkflowInstanceEvent<Payload>,
  ): Promise<void>;
  /** Pauses immediately when idle, or after the active step completes. */
  pause(): Promise<void>;
  /** Resumes a paused instance or cancels a pending pause, preserving remaining wait durations. */
  resume(): Promise<void>;
  /** Starts a new generation from the beginning or a selected history step. */
  restart(options?: WorkflowInstanceRestartOptions): Promise<void>;
  /** Deletes state and resets active execution so old callbacks cannot resurrect it. */
  delete(): Promise<void>;
}

/** Per-input results from deleting 1–100 Workflow instance IDs. */
interface WorkflowDeleteBatchResult {
  /** Successful input IDs; duplicate IDs appear once per input occurrence. */
  deleted: {
    /** ID of the deleted instance. */
    id: string;
  }[];
  /** Per-ID failures; one missing instance does not fail the whole batch. */
  errors: {
    /** Input ID that could not be deleted. */
    id: string;
    /** 10400 means not found; 10001 means internal failure. */
    code: 10400 | 10001;
    /** Machine-readable error key. */
    message:
      | "workflows.api.error.instance.not_found"
      | "workflows.api.error.internal_server";
  }[];
}

/**
 * Workflow binding backed by one durable cell per instance. run() replays from
 * the start; code outside steps repeats, and non-step work may stall for at most
 * 60 seconds. Workflows execute only in the script declaring their binding.
 */
interface Workflow<Params = unknown, Output = unknown> {
  /** Creates an instance; any existing unexpired ID, including a terminal one, rejects. */
  create(
    options?: WorkflowInstanceCreateOptions<Params>,
  ): Promise<WorkflowInstance<Output>>;
  /** Creates 1–100 instances, skipping existing IDs and per-item clone failures. */
  createBatch(
    options: WorkflowInstanceCreateOptions<Params>[],
  ): Promise<WorkflowInstance<Output>[]>;
  /** Looks up an existing instance; nonexistent IDs reject rather than creating one. */
  get(id: string): Promise<WorkflowInstance<Output>>;
  /** Deletes 1–100 instance IDs, returning success/error records in input order within each list. */
  deleteBatch(instanceIds: string[]): Promise<WorkflowDeleteBatchResult>;
}

/** Built-in Workflow error module; no runtime WorkflowStep/WorkflowEvent exports. */
declare module "cloudflare:workflows" {
  /** A step failure that bypasses retries and fails the step immediately. */
  export class NonRetryableError extends Error {
    /** Creates a permanent failure; the optional name defaults to NonRetryableError. */
    constructor(message: string, name?: string);
  }
}
