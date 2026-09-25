// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A file workspace over HTTP: the sandbox's file API, rooted in the
 * workspace, with paths that try to leave it refused (`..`, absolute paths
 * elsewhere, symbolic links pointing out).
 *
 * - `PUT /files/<path>` writes the body (any bytes), creating directories.
 * - `GET /files/<path>` answers the bytes (a 409 when the file changed
 *   while it was read); `DELETE /files/<path>` removes it.
 * - `GET /list/<dir>?recursive=1&hidden=1&limit=n&cursor=c` lists a
 *   directory, a page of at most `limit` entries; a `truncated` answer has
 *   the `cursor` of the next page.
 * - `GET /stat/<path>` answers kind, size and modification time.
 * - `POST /move` `{"from", "to"}` renames (a body of at most 4 KiB).
 *
 * Paths are percent-decoded, so `%2E%2E%2F` is `../` and is refused like it;
 * a path that is not valid percent-encoding is a 400.
 *
 * A PUT body is read with `readBounded` and refused (413) the moment it
 * passes the cap (`MAX_FILE_BYTES`, at most the class's 8 MiB), before it
 * is all in memory. Errors answer only the sandbox's code
 * (`{"error": "outside_workspace"}`), never its message.
 *
 * **Deliberately unauthenticated demo; never deploy it.** Anyone who can
 * reach this Worker can read, overwrite, list and delete every file in its
 * one shared sandbox, and keep the container running. A real service gives
 * each authenticated caller their own sandbox (see `runner.ts` and
 * `jobs.ts`).
 *
 * ```console
 * $ buck2 run root//src/celld/box/sandbox/examples:workspace-dev
 * $ curl -s -X PUT localhost:9876/files/notes/todo.txt --data-binary 'buy milk'
 * $ curl -s 'localhost:9876/list/?recursive=1'
 * ```
 */

import { BoundsError, readBounded, readTextBounded } from "@celld/core/bounds";
import { getSandbox, type ListFilesOptions } from "@celld/box/sandbox";
import { errorResponse, Sandbox } from "@celld/box/sandbox/durable";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class Workspace extends Sandbox {
  override sleepAfter = "10m";
  override settings = {
    tier: "trusted" as const,
    maxFileBytes: MAX_FILE_BYTES,
  };
}

interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  /** A lower cap for PUT bodies, in bytes; default (and at most) 8 MiB. */
  MAX_FILE_BYTES?: string;
  UNSAFE_LOCAL_DEMO?: string;
}

function putLimit(env: Env): number {
  const asked = Number(env.MAX_FILE_BYTES ?? MAX_FILE_BYTES);
  return Number.isSafeInteger(asked) && asked > 0
    ? Math.min(asked, MAX_FILE_BYTES)
    : MAX_FILE_BYTES;
}

const MAX_LIST_LIMIT = 10_000;

class BadRequest extends Error {}

function route(url: URL, prefix: string): string | null {
  if (!url.pathname.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch (error) {
    if (error instanceof URIError) throw new BadRequest("bad path encoding");
    throw error;
  }
}

function listOptions(params: URLSearchParams): ListFilesOptions {
  const limit = params.get("limit");
  const cursor = params.get("cursor");
  if (limit !== null && !/^[1-9][0-9]{0,4}$/.test(limit)) {
    throw new BadRequest("limit");
  }
  if (limit !== null && Number(limit) > MAX_LIST_LIMIT) {
    throw new BadRequest("limit");
  }
  return {
    recursive: params.get("recursive") === "1",
    includeHidden: params.get("hidden") === "1",
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(cursor === null ? {} : { cursor }),
  };
}

async function readMove(
  request: Request,
): Promise<{ from: string; to: string }> {
  let body: unknown;
  try {
    body = JSON.parse(await readTextBounded(request, { maxBytes: 4096 }));
  } catch (error) {
    if (error instanceof BoundsError && error.code === "too_large") throw error;
    throw new BadRequest("body");
  }
  if (
    typeof body !== "object" || body === null || Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    typeof (body as { from?: unknown }).from !== "string" ||
    typeof (body as { to?: unknown }).to !== "string"
  ) {
    throw new BadRequest("body");
  }
  return body as { from: string; to: string };
}

// The sandbox's code and status, without its message: for helper failures
// the message is the helper's stderr, which is not for anonymous callers.
async function opaque(error: unknown): Promise<Response> {
  if (error instanceof BadRequest) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (error instanceof BoundsError && error.code === "too_large") {
    return Response.json({ error: "too_large" }, { status: 413 });
  }
  const answer = errorResponse(error);
  const { error: code } = await answer.json() as { error: string };
  return Response.json({ error: code }, { status: answer.status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      env.UNSAFE_LOCAL_DEMO !== "1" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) return Response.json({ error: "unsafe_demo_disabled" }, { status: 403 });
    const sandbox = getSandbox(env.WORKSPACE, "workspace");
    try {
      const file = route(url, "/files/");
      if (file !== null) {
        switch (request.method) {
          case "PUT": {
            let bytes: Uint8Array;
            try {
              bytes = await readBounded(request, { maxBytes: putLimit(env) });
            } catch (error) {
              if (error instanceof BoundsError && error.code === "too_large") {
                return Response.json({
                  error: "too_large",
                  message: `a file is at most ${putLimit(env)} bytes`,
                }, { status: 413 });
              }
              throw error;
            }
            await sandbox.writeFile(file, bytes);
            return Response.json({ path: file, size: bytes.byteLength }, {
              status: 201,
            });
          }
          case "GET": {
            const found = await sandbox.readFile(file, { encoding: "bytes" });
            if (found.truncated) {
              return Response.json({ error: "changed_during_read" }, {
                status: 409,
              });
            }
            return new Response(found.content as Uint8Array<ArrayBuffer>, {
              headers: { "content-type": "application/octet-stream" },
            });
          }
          case "DELETE":
            await sandbox.deleteFile(file);
            return new Response(null, { status: 204 });
        }
      }
      const dir = route(url, "/list/");
      if (dir !== null) {
        return Response.json(
          await sandbox.listFiles(dir, listOptions(url.searchParams)),
        );
      }
      const stat = route(url, "/stat/");
      if (stat !== null) return Response.json(await sandbox.stat(stat));
      if (request.method === "POST" && url.pathname === "/move") {
        const { from, to } = await readMove(request);
        await sandbox.renameFile(from, to);
        return Response.json({ from, to });
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      return await opaque(error);
    }
  },
};
