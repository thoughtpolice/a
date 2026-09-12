// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Serves the browser page and the compiled module from an explicit allowlist.
// Usage: serve.mjs <breakout.wasm> [port]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [modulePath, portArgument = "8080"] = process.argv.slice(2);
if (!modulePath) {
  throw new Error("Usage: serve.mjs <breakout.wasm> [port]");
}
const port = Number(portArgument);
const directory = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/host.mjs", ["host.mjs", "text/javascript; charset=utf-8"]],
  ["/breakout.wasm", [path.resolve(modulePath), "application/wasm"]],
]);

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    response.writeHead(400).end("bad request");
    return;
  }
  // `files` is a fixed allowlist keyed by exact pathname (the URL parser
  // above already collapses `..` segments), so lookups outside the served
  // root simply miss and fall through to 404 rather than resolving a path.
  const entry = files.get(pathname);
  if (!entry) {
    response.writeHead(404).end("not found");
    return;
  }
  const [file, type] = entry;
  try {
    const body = fs.readFileSync(
      path.isAbsolute(file) ? file : path.join(directory, file),
    );
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
    }).end(body);
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Console Breakout at http://127.0.0.1:${port}/`);
});
