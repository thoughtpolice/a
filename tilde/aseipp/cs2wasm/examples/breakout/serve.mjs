// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Serve this example's assets and generated module on all network interfaces.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";

const port = Number(process.argv[2] ?? 8080);
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  process.argv.length > 3
) {
  throw new Error("Usage: node examples/breakout/serve.mjs [port]");
}
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/host.mjs", ["host.mjs", "text/javascript; charset=utf-8"]],
  // host.mjs imports '../entity-host.mjs', which resolves to the site root.
  ["/entity-host.mjs", [
    "../entity-host.mjs",
    "text/javascript; charset=utf-8",
  ]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/breakout.wasm", ["../../publish/breakout.wasm", "application/wasm"]],
]);
const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    response.writeHead(400).end("Invalid request path");
    return;
  }
  const route = files.get(pathname);
  if (!route) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const bytes = await readFile(new URL(route[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": route[1],
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch (error) {
    const missing = error.code === "ENOENT";
    response.writeHead(missing ? 404 : 500, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end(
      missing && route[0].endsWith(".wasm")
        ? "Compile first: ./publish/gameplayc -o publish/breakout.wasm examples/breakout/Breakout.cs"
        : "Unable to read example asset",
    );
  }
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "0.0.0.0", () => {
  console.log(`Breakout: http://127.0.0.1:${port}`);
  for (const address of Object.values(networkInterfaces()).flat()) {
    if (address && address.family === "IPv4" && !address.internal) {
      console.log(`Network: http://${address.address}:${port}`);
    }
  }
  console.log(`Listening on 0.0.0.0:${port}. Press Ctrl+C to stop.`);
});
