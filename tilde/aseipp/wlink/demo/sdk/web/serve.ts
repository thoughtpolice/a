// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A static server for one built package.
 *
 * Module scripts and `WebAssembly.instantiateStreaming` do not work from a
 * `file://` page, so opening a package in a browser needs a server; this is
 * the smallest one that serves `application/wasm` correctly and never leaves
 * the directory it was pointed at.
 */

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentType(path: string): string {
  const at = path.lastIndexOf(".");
  return (at < 0 ? undefined : TYPES[path.slice(at)]) ?? "application/octet-stream";
}

export interface ServeOptions {
  root: string;
  port: number;
  hostname: string;
}

export function parseOptions(argv: string[]): ServeOptions {
  let root: string | null = null;
  let port = 8000;
  let hostname = "127.0.0.1";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--host") hostname = argv[++i];
    else if (root === null) root = argv[i];
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  if (root === null) throw new Error("usage: serve DIR [--port N] [--host ADDRESS]");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid --port");
  return { root, port, hostname };
}

/** Resolves a request path inside `root`, or null when it would escape it. */
export function resolve(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const parts: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (segment.includes("\0")) return null;
    parts.push(segment);
  }
  return parts.length === 0 ? `${root}/index.html` : `${root}/${parts.join("/")}`;
}

function headers(path: string): Headers {
  const value = new Headers({
    "content-type": contentType(path),
    // A package is rebuilt in place, so a cached copy is always the wrong one.
    "cache-control": "no-store",
    // Harmless here, and what a cross-origin-isolated page would need later.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
  });
  return value;
}

export function serve(options: ServeOptions): Deno.HttpServer<Deno.NetAddr> {
  const root = Deno.realPathSync(options.root);
  return Deno.serve({
    port: options.port,
    hostname: options.hostname,
    onListen: ({ hostname, port }) => {
      console.log(`serving ${root} at http://${hostname}:${port}/`);
    },
  }, (request) => {
    const path = resolve(root, new URL(request.url).pathname);
    if (path === null || !path.startsWith(root)) {
      return new Response("not found\n", { status: 404 });
    }
    let file: Deno.FsFile;
    try {
      const info = Deno.statSync(path);
      if (!info.isFile) return new Response("not found\n", { status: 404 });
      file = Deno.openSync(path, { read: true });
    } catch {
      return new Response("not found\n", { status: 404 });
    }
    return new Response(file.readable, { headers: headers(path) });
  });
}

if (import.meta.main) {
  try {
    serve(parseOptions(Deno.args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
