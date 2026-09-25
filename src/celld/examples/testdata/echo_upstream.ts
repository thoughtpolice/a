// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The echo example's fake upstream: it answers every request with what it
 * received, or with the next scripted `{status, body}` when the spec queued
 * one. It tells the Worker where it is through `ECHO_URL`.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";

interface Scripted {
  readonly status: number;
  readonly body: unknown;
}

const queue: Scripted[] = [];

serveUpstream({
  async fetch(request) {
    const next = queue.shift();
    if (next !== undefined) {
      return Response.json(next.body, { status: next.status });
    }
    return Response.json({
      method: request.method,
      path: new URL(request.url).pathname,
      body: await request.text(),
    });
  },
  script(instruction) {
    queue.push(instruction as Scripted);
  },
  vars: (origin) => ({ ECHO_URL: `${origin}/echo` }),
});
