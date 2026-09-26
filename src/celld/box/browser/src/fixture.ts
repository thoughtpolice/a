// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  parseJsonBounded,
  readTextBounded,
  strictRecord,
  utf8Length,
} from "@celld/core/bounds";
import { type CdpConnection, connectCdp } from "./cdp.ts";

export interface BrowserFixtureOptions {
  /** Private HTTP loopback origin provided by the Buck fixture runner. */
  readonly endpoint: string;
  /** Per-test control secret; never put it in a URL or log. */
  readonly token: string;
  /** Served as /index.html inside the isolated browser container. */
  readonly html?: string;
  /** Entire setup + callback deadline; cleanup has its own bounded deadline. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface BrowserFixture {
  readonly cdp: CdpConnection;
  /** Browser-side origin, not reachable as this URL from the host test driver. */
  readonly origin: string;
  /** Privileged, short-lived capability URL. Do not log it. */
  readonly webSocketUrl: string;
  readonly sessionId: string;
}

/**
 * Own one fresh browser sandbox for a test, destroying it on success, failure
 * or cancellation. The callback runs outside the container. This POC accepts
 * only the local Buck runner's endpoint; it is not a production browser service.
 * CDP cannot preempt synchronous JavaScript in the caller; callback code is trusted.
 */
export async function withBrowserFixture<T>(
  options: BrowserFixtureOptions,
  body: (fixture: BrowserFixture) => Promise<T>,
): Promise<T> {
  strictRecord(
    options,
    ["endpoint", "token", "html", "timeoutMs", "signal"],
    "browser fixture",
  );
  const { endpoint, token, signal } = options;
  const html = options.html === undefined
    ? "<!doctype html><title>Browser fixture</title>"
    : options.html;
  const timeoutMs = options.timeoutMs === undefined
    ? 60_000
    : options.timeoutMs;
  if (typeof endpoint !== "string") {
    throw new TypeError("endpoint must be an origin");
  }
  const base = new URL(endpoint);
  if (
    base.protocol !== "http:" || base.hostname !== "127.0.0.1" ||
    base.pathname !== "/" ||
    base.search || base.hash || base.username || base.password
  ) {
    throw new TypeError("browser fixture requires an HTTP 127.0.0.1 origin");
  }
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new TypeError("browser fixture requires a private control token");
  }
  if (typeof html !== "string" || utf8Length(html) > 65_536) {
    throw new TypeError("fixture HTML exceeds 64 KiB");
  }
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
  ) throw new TypeError("invalid fixture timeoutMs");
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("invalid fixture signal");
  }
  if (typeof body !== "function") {
    throw new TypeError("browser fixture callback required");
  }
  signal?.throwIfAborted();

  const sessionId = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const url = `${base.origin}/sessions/${sessionId}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("browser fixture timed out")),
    timeoutMs,
  );
  let cdp: CdpConnection | undefined;
  let abortListener: (() => void) | undefined;
  let failure: unknown;
  let failed = false;
  let result!: T;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ html }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `browser fixture startup failed (HTTP ${response.status})`,
      );
    }
    const data = parseJsonBounded(
      await readTextBounded(response, {
        maxBytes: 16_384,
        signal: controller.signal,
      }),
      {
        maxDepth: 2,
        maxKeys: 4,
        maxItems: 4,
        maxBytes: 16_384,
      },
    );
    strictRecord(data, ["origin", "webSocketPath"], "browser fixture response");
    if (
      data.origin !== "http://127.0.0.1:8080" ||
      typeof data.webSocketPath !== "string" ||
      !new RegExp(`^/sessions/${sessionId}/devtools/browser/[a-f0-9-]{36}$`)
        .test(data.webSocketPath)
    ) {
      throw new Error("invalid browser fixture response");
    }
    const webSocketUrl = `ws://${base.host}${data.webSocketPath}`;
    cdp = await connectCdp(webSocketUrl, {
      signal: controller.signal,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    controller.signal.throwIfAborted();
    const cancelled = new Promise<never>((_, reject) => {
      abortListener = () => {
        cdp?.close();
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", abortListener, {
        once: true,
      });
      if (controller.signal.aborted) abortListener();
    });
    result = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return body(
          Object.freeze({
            cdp: cdp!,
            origin: data.origin as string,
            webSocketUrl,
            sessionId,
          }),
        );
      }),
      cancelled,
    ]);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
    cdp?.close();
  }
  // The ID is chosen before POST: even a lost startup response can be cleaned
  // up. DELETE uses a separate signal; the timed-out operation cannot cancel it.
  const cleanup = new AbortController();
  const cleanupTimer = setTimeout(() => cleanup.abort(), 60_000);
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers,
      redirect: "error",
      signal: cleanup.signal,
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(
        `browser fixture cleanup failed (HTTP ${response.status})`,
      );
    }
  } catch (error) {
    if (failed) {
      throw new AggregateError(
        [failure, error],
        "browser test and cleanup failed",
      );
    }
    throw error;
  } finally {
    clearTimeout(cleanupTimer);
  }
  if (failed) throw failure;
  return result;
}
