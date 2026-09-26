// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  jsonSnapshot,
  parseJsonBounded,
  safeInt,
  strictRecord,
  utf8Length,
} from "@celld/core/bounds";

/** Bounds apply to connection establishment and each command independently. */
export interface CdpOptions {
  /** Aborting this signal closes the entire connection. */
  readonly signal?: AbortSignal;
  /** Default 10 seconds; integer milliseconds, 1–120,000. */
  readonly timeoutMs?: number;
  /** Default 64 outstanding commands; 1–4096. */
  readonly maxPending?: number;
  /** Default 1 MiB per message and queued outgoing bytes; 1–16 MiB. */
  readonly maxMessageBytes?: number;
}

export interface CdpSendOptions {
  readonly sessionId?: string;
  /** Cancels waiting, not browser-side execution of an already sent command. */
  readonly signal?: AbortSignal;
}

/** A raw, flattened-session CDP transport; unsolicited events are discarded. */
export interface CdpConnection {
  /** T is the caller's protocol type assertion, not runtime result validation. */
  send<T extends object = Record<string, unknown>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: CdpSendOptions,
  ): Promise<T>;
  /** Idempotently close and reject every pending command immediately. */
  close(): void;
}

/** A bounded error response returned by Chrome, as opposed to transport failure. */
export class CdpProtocolError extends Error {
  override readonly name = "CdpProtocolError";
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`CDP ${method} failed (${code}): ${message.slice(0, 1024)}`);
  }
}

function checkSignal(
  signal: unknown,
): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const methodPattern = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/;
const aborted = () => new DOMException("CDP operation aborted", "AbortError");
const timedOut = () =>
  new DOMException("CDP operation timed out", "TimeoutError");

/**
 * Connect directly to a caller-trusted ws:/wss: DevTools endpoint. This grants
 * browser control: never accept the URL or commands from untrusted users.
 * No endpoint discovery, reconnect, retries, or command replay is performed.
 * Message bounds apply after native WebSocket frame delivery, not its buffers.
 */
export async function connectCdp(
  url: string,
  options: CdpOptions = {},
): Promise<CdpConnection> {
  strictRecord(options as unknown, [
    "signal",
    "timeoutMs",
    "maxPending",
    "maxMessageBytes",
  ], "CDP options");
  const signal = options.signal;
  checkSignal(signal);
  const timeoutMs = safeInt(
    options.timeoutMs === undefined ? 10_000 : options.timeoutMs,
    {
      name: "timeoutMs",
      min: 1,
      max: 120_000,
    },
  );
  const maxPending = safeInt(
    options.maxPending === undefined ? 64 : options.maxPending,
    {
      name: "maxPending",
      min: 1,
      max: 4096,
    },
  );
  const maxMessageBytes = safeInt(
    options.maxMessageBytes === undefined ? 1_048_576 : options.maxMessageBytes,
    {
      name: "maxMessageBytes",
      min: 1,
      max: 16_777_216,
    },
  );
  if (
    typeof url !== "string" || url.length > 4096 || !/^wss?:\/\//i.test(url) ||
    /^wss?:\/\/[^/?#]*@/i.test(url) ||
    /[\s\p{Cc}\\]/u.test(url)
  ) throw new TypeError("invalid CDP URL");
  const endpoint = new URL(url);
  if (
    !["ws:", "wss:"].includes(endpoint.protocol) || !endpoint.hostname ||
    endpoint.username || endpoint.password || endpoint.hash || url.includes("#")
  ) {
    throw new TypeError(
      "CDP URL must use ws/wss without credentials or fragments",
    );
  }
  if (signal?.aborted) throw aborted();

  const ws = new WebSocket(endpoint.href);
  ws.binaryType = "arraybuffer";
  const ready = Promise.withResolvers<void>();
  type Pending = {
    readonly method: string;
    readonly sessionId: string | undefined;
    finish(error?: unknown, result?: object): void;
  };
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let closed: Error | undefined;
  const connectTimer = setTimeout(() => stop(timedOut()), timeoutMs);
  const abortConnection = () => stop(aborted());
  function stop(error: Error): void {
    if (closed) return;
    closed = error;
    clearTimeout(connectTimer);
    signal?.removeEventListener("abort", abortConnection);
    ws.onopen =
      ws.onmessage =
      ws.onerror =
      ws.onclose =
        null;
    ready.reject(error);
    for (const request of pending.values()) request.finish(error);
    // Closing while CONNECTING is supported by native WebSocket implementations.
    try {
      ws.close();
    } catch {
      ws.addEventListener("open", () => ws.close(), { once: true });
    }
  }
  signal?.addEventListener("abort", abortConnection, { once: true });
  ws.onopen = () => {
    clearTimeout(connectTimer);
    ready.resolve();
  };
  ws.onerror = () => stop(new Error("CDP WebSocket failed"));
  ws.onclose = () => stop(new Error("CDP connection closed"));
  ws.onmessage = (event) => {
    try {
      if (typeof event.data !== "string") {
        throw new Error("CDP requires text messages");
      }
      const message = parseJsonBounded(event.data, {
        maxBytes: maxMessageBytes,
        maxDepth: 32,
        maxKeys: 4096,
        maxItems: 16384,
      });
      strictRecord(message, [
        "id",
        "result",
        "error",
        "method",
        "params",
        "sessionId",
      ], "CDP message");
      if (message.id === undefined) {
        if (
          typeof message.method !== "string" || message.method.length > 256 ||
          !methodPattern.test(message.method) || "result" in message ||
          "error" in message || ("params" in message && !record(message.params))
        ) throw new Error("invalid CDP event");
        return;
      }
      if (!Number.isSafeInteger(message.id) || (message.id as number) <= 0) {
        throw new Error("invalid CDP response id");
      }
      const request = pending.get(message.id as number);
      if (!request) return; // A response may arrive after timeout/cancellation.
      if (
        message.sessionId !== request.sessionId || "method" in message ||
        "params" in message || ("result" in message) === ("error" in message)
      ) throw new Error("invalid CDP response envelope");
      if ("error" in message) {
        strictRecord(message.error, ["code", "message", "data"], "CDP error");
        if (
          !Number.isSafeInteger(message.error.code) ||
          typeof message.error.message !== "string"
        ) {
          throw new Error("invalid CDP error");
        }
        request.finish(
          new CdpProtocolError(
            request.method,
            message.error.code as number,
            message.error.message,
          ),
        );
      } else {
        if (!record(message.result)) throw new Error("invalid CDP result");
        request.finish(
          undefined,
          jsonSnapshot(message.result, {
            maxBytes: maxMessageBytes,
            maxItems: 16384,
          }),
        );
      }
    } catch {
      stop(new Error("invalid or oversized CDP message"));
    }
  };
  await ready.promise;
  if (closed) throw closed;
  return Object.freeze({
    async send<T extends object = Record<string, unknown>>(
      method: string,
      params: Readonly<Record<string, unknown>> = {},
      sendOptions: CdpSendOptions = {},
    ): Promise<T> {
      strictRecord(
        sendOptions as unknown,
        ["sessionId", "signal"],
        "CDP send options",
      );
      const { sessionId, signal: commandSignal } = sendOptions;
      checkSignal(commandSignal);
      if (
        typeof method !== "string" || method.length > 256 ||
        !methodPattern.test(method)
      ) {
        throw new TypeError("invalid CDP method");
      }
      if (
        sessionId !== undefined &&
        (typeof sessionId !== "string" ||
          !/^[\x21-\x7e]{1,256}$/.test(sessionId))
      ) {
        throw new TypeError("invalid CDP sessionId");
      }
      if (closed) throw closed;
      if (commandSignal?.aborted) throw aborted();
      if (pending.size >= maxPending) {
        throw new Error("CDP pending command limit reached");
      }
      if (nextId >= Number.MAX_SAFE_INTEGER) {
        throw new Error("CDP command ids exhausted");
      }
      if (!record(params)) {
        throw new TypeError("CDP params must be a JSON object");
      }
      const id = ++nextId;
      const payload = jsonSnapshot({
        id,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId }),
      }, { maxBytes: maxMessageBytes, maxItems: 16384 });
      const text = JSON.stringify(payload);
      if (ws.bufferedAmount + utf8Length(text) > maxMessageBytes) {
        throw new Error("CDP outgoing buffer limit reached");
      }
      if (closed) throw closed;
      if (commandSignal?.aborted) throw aborted();
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => finish(aborted());
        const timer = setTimeout(() => finish(timedOut()), timeoutMs);
        function finish(error?: unknown, result?: object): void {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          commandSignal?.removeEventListener("abort", onAbort);
          if (error !== undefined) reject(error);
          else resolve(result as T);
        }
        pending.set(id, { method, sessionId, finish });
        commandSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          ws.send(text);
        } catch (error) {
          finish(error);
        }
      });
    },
    close: () => stop(new Error("CDP connection closed")),
  });
}
