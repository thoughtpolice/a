// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers shared by the suites.
 *
 * @module
 */

import { assertEquals, show } from "@celld/assert";

/** Whether two types are identical, for `const _: true = ...` assertions. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

/** Anything with the router's `fetch`. */
export interface Fetches {
  fetch(
    request: Request,
    env?: unknown,
    ctx?: ExecutionContext,
  ): Promise<Response>;
}

/** Options for {@link call}: the request's parts. */
export interface CallOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: BodyInit;
  readonly env?: unknown;
  readonly ctx?: ExecutionContext;
  /** Default `https://api.example.com`. */
  readonly origin?: string;
}

/** A response with its body read. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The body as JSON, or undefined when it is not JSON. */
  readonly json: Record<string, unknown> | undefined;
}

/** Sends one request to `app` and reads the answer. */
export async function call(
  app: Fetches,
  path: string,
  options: CallOptions = {},
): Promise<Answer> {
  const headers = new Headers(options.headers);
  let body = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const request = new Request(
    (options.origin ?? "https://api.example.com") + path,
    {
      method,
      headers,
      body,
    },
  );
  const response = await app.fetch(request, options.env, options.ctx);
  const text = await response.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** Asserts the status, with the body in the message when it is wrong. */
export function assertStatus(answer: Answer, status: number): void {
  assertEquals(answer.status, status, `status (body ${answer.text})`);
}

/** Asserts a header's exact value (null for absent). */
export function assertHeader(
  answer: Answer,
  name: string,
  value: string | null,
): void {
  assertEquals(answer.headers.get(name), value, `header ${name}`);
}

/** Asserts `value` is a subset match of `expected` (object keys only as listed). */
export function assertMatch(
  value: unknown,
  expected: Record<string, unknown>,
): void {
  const actual = value as Record<string, unknown> | undefined;
  for (const [key, want] of Object.entries(expected)) {
    assertEquals(actual?.[key], want, `${key} of ${show(value)}`);
  }
}

/** An `ExecutionContext` that records `waitUntil` promises. */
export function recordingContext(): ExecutionContext & {
  pending: Promise<unknown>[];
} {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException: () => {},
    abort: () => {},
    exports: {},
    props: undefined,
  };
}
