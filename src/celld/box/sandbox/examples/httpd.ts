// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `devserver` example's start of busybox httpd, apart from the Durable
 * Object so `devserver_race_test.ts` can drive it with a stand-in.
 *
 * @module
 */

import type {
  ListProcessesOptions,
  ProcessInfo,
  ProcessList,
  ProcessOptions,
} from "@celld/box/sandbox";

/** The sandbox operations a start needs: `Dev` itself, or a test's stand-in. */
export interface HttpdHost {
  listProcesses(options?: ListProcessesOptions): Promise<ProcessList>;
  writeFile(path: string, content: string): Promise<void>;
  startProcess(argv: string[], options?: ProcessOptions): Promise<ProcessInfo>;
}

/** Pages of process records read at most, 1,000 each. */
const MAX_PAGES = 16;

/** The running httpd, if there is one. */
async function running(host: HttpdHost): Promise<ProcessInfo | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await host.listProcesses({ cursor, limit: 1_000 });
    const found = listed.processes.find((process) =>
      process.name === "httpd" && process.status === "running"
    );
    if (found !== undefined) return found;
    if (listed.cursor === null) return undefined;
    cursor = listed.cursor;
  }
  return undefined;
}

/** The start in flight per host, which overlapping callers share. */
const starting = new WeakMap<HttpdHost, Promise<ProcessInfo>>();

/**
 * Writes the page and starts httpd on port 8080, unless it runs. Calls on
 * one host that overlap share one start: a list and then a start across
 * awaits would let two callers both find no server and both start one,
 * and the second httpd cannot bind. This holds within one object, which
 * is why `Dev` runs it rather than the Worker.
 */
export function serveOnce(host: HttpdHost): Promise<ProcessInfo> {
  let start = starting.get(host);
  if (start === undefined) {
    start = serve(host).finally(() => starting.delete(host));
    starting.set(host, start);
  }
  return start;
}

async function serve(host: HttpdHost): Promise<ProcessInfo> {
  const current = await running(host);
  await host.writeFile(
    "site/index.html",
    "<h1>hello from the dev server</h1>\n",
  );
  return current ?? await host.startProcess(
    ["httpd", "-f", "-p", "8080", "-h", "site"],
    { name: "httpd", mutates: false },
  );
}
