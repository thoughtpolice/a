// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A reference server for the "RPC" backend. Data from jj CLI clients is stored
// as content-addressed blobs; the client is assumed to derive the content
// address from a (presumably strong) hash function.
//
// <kind> is one of: commit, tree, file, symlink, view, operation.
//
// Layout:
//
//   ["blob", <kind>, <id>]  -> Uint8Array   the object bytes
//   ["op_head", <id>]       -> true         presence means this op is a head
//
// Endpoints:
//   GET  /read_<kind>/<id>                  -> 200 bytes | 404
//   POST /write_<kind>/<id>                 -> 200 (body = bytes)
//   GET  /op_heads                          -> 200 newline-separated hex ids
//   POST /op_heads/update                   -> 200 (line 1 = new head, rest = old heads)
//   GET  /resolve_operation_id_prefix/<hex> -> 200 full hex | 404 | 409 (ambiguous)
//
// Note: This demonstration server uses Deno KV, which is persistent across
// restart; however it caps values at 64 KiB, bounding the maximum per-object
// (per-file) size it can store.

const KINDS = new Set(["commit", "tree", "file", "symlink", "view", "operation"]);
const kv = await Deno.openKv();

function ok(body: BodyInit = ""): Response {
  return new Response(body, { status: 200 });
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const segs = url.pathname.split("/").filter((s) => s.length > 0);
  const method = req.method;

  // Operation heads: list / atomic-ish update.
  if (segs.length === 1 && segs[0] === "op_heads" && method === "GET") {
    const ids: string[] = [];
    for await (const entry of kv.list({ prefix: ["op_head"] })) {
      ids.push(entry.key[1] as string);
    }
    return ok(ids.join("\n"));
  }
  if (
    segs.length === 2 && segs[0] === "op_heads" && segs[1] === "update" &&
    method === "POST"
  ) {
    const lines = (await req.text())
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const [newId, ...oldIds] = lines;
    const atomic = kv.atomic();
    if (newId) atomic.set(["op_head", newId], true);
    for (const old of oldIds) {
      if (old !== newId) atomic.delete(["op_head", old]);
    }
    await atomic.commit();
    return ok();
  }

  // Operation id prefix resolution.
  if (
    segs.length === 2 && segs[0] === "resolve_operation_id_prefix" &&
    method === "GET"
  ) {
    const prefix = segs[1];
    const matches: string[] = [];
    for await (const entry of kv.list({ prefix: ["blob", "operation"] })) {
      const id = entry.key[2] as string;
      if (id.startsWith(prefix)) matches.push(id);
    }
    if (matches.length === 0) return notFound();
    if (matches.length === 1) return ok(matches[0]);
    return new Response("ambiguous", { status: 409 });
  }

  // Blob read/write: /<read|write>_<kind>/<id>.
  if (segs.length === 2) {
    const [action, id] = segs;
    if (action.startsWith("read_") && method === "GET") {
      const kind = action.slice("read_".length);
      if (KINDS.has(kind)) {
        const res = await kv.get<Uint8Array<ArrayBuffer>>(["blob", kind, id]);
        return res.value ? ok(res.value) : notFound();
      }
    }
    if (action.startsWith("write_") && method === "POST") {
      const kind = action.slice("write_".length);
      if (KINDS.has(kind)) {
        const body = new Uint8Array(await req.arrayBuffer());
        await kv.set(["blob", kind, id], body);
        return ok();
      }
    }
  }

  return new Response(`unknown route: ${method} ${url.pathname}`, {
    status: 400,
  });
}

export default {
  async fetch(req: Request) {
    const res = await handle(req);
    console.error(`${req.method} ${new URL(req.url).pathname} -> ${res.status}`);
    return res;
  },

  onListen({ hostname, port }) {
    console.error(`qq server listening @ http://${hostname}:${port}/`);
  },
} satisfies Deno.ServeDefaultExport;
