// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A file workspace over HTTP: the sandbox's file API, rooted in the
 * workspace, with paths that try to leave it refused (`..`, absolute paths
 * elsewhere, symbolic links pointing out).
 *
 * - `PUT /files/<path>` writes the body (any bytes), creating directories.
 * - `GET /files/<path>` answers the bytes; `DELETE /files/<path>` removes it.
 * - `GET /list/<dir>?recursive=1&hidden=1` lists a directory.
 * - `GET /stat/<path>` answers kind, size and modification time.
 * - `POST /move` `{"from", "to"}` renames.
 *
 * Paths are percent-decoded, so `%2E%2E%2F` is `../` and is refused like it.
 *
 * ```console
 * $ buck2 run root//src/celld/sandbox/examples:workspace-dev
 * $ curl -s -X PUT localhost:9876/files/notes/todo.txt --data-binary 'buy milk'
 * $ curl -s 'localhost:9876/list/?recursive=1'
 * ```
 */

import { getSandbox } from "@celld/sandbox";
import { errorResponse, Sandbox } from "@celld/sandbox/durable";

export class Workspace extends Sandbox {
  override sleepAfter = "10m";
  override settings = { maxFileBytes: 8 * 1024 * 1024 };
}

interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
}

function route(url: URL, prefix: string): string | null {
  if (!url.pathname.startsWith(prefix)) return null;
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.WORKSPACE, "workspace");
    try {
      const file = route(url, "/files/");
      if (file !== null) {
        switch (request.method) {
          case "PUT": {
            const bytes = new Uint8Array(await request.arrayBuffer());
            await sandbox.writeFile(file, bytes);
            return Response.json({ path: file, size: bytes.byteLength }, {
              status: 201,
            });
          }
          case "GET": {
            const found = await sandbox.readFile(file, { encoding: "bytes" });
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
          await sandbox.listFiles(dir, {
            recursive: url.searchParams.get("recursive") === "1",
            includeHidden: url.searchParams.get("hidden") === "1",
          }),
        );
      }
      const stat = route(url, "/stat/");
      if (stat !== null) return Response.json(await sandbox.stat(stat));
      if (request.method === "POST" && url.pathname === "/move") {
        const { from, to } = await request.json() as {
          from: string;
          to: string;
        };
        await sandbox.renameFile(from, to);
        return Response.json({ from, to });
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
};
