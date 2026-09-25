// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Interop: the official TypeScript SDK's client (`@modelcontextprotocol/client`,
 * which implements 2026-07-28) against the `@celld/mcp` server of the live
 * test. `tests/live_run.py` runs it on the VM only, with Deno's npm cache
 * under `~/.cache/celld-live`; it is not a build target and never runs in
 * the repository.
 *
 * Arguments: `--url <origin>`, `--version <sdk version>`. Prints a JSON
 * report; exits 1 if a check failed.
 *
 * @module
 */

const url = (() => {
  const i = Deno.args.indexOf("--url");
  return i >= 0 ? Deno.args[i + 1] : "http://127.0.0.1:8000";
})();
const version = (() => {
  const i = Deno.args.indexOf("--version");
  return i >= 0 ? Deno.args[i + 1] : "2.1.0";
})();

const sdk = await import(`npm:@modelcontextprotocol/client@${version}`);
const { Client, StreamableHTTPClientTransport } = sdk;

const checks: { name: string; ok: boolean; detail: unknown }[] = [];
async function check(
  name: string,
  body: () => Promise<unknown>,
  expect: (detail: unknown) => boolean,
): Promise<void> {
  try {
    const detail = await body();
    checks.push({ name, ok: expect(detail), detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error) });
  }
}

const client = new Client(
  { name: "official-sdk-interop", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
  requestInit: { headers: { authorization: "Bearer runtime-token" } },
});

await check("connect (server/discover, pinned 2026-07-28)", async () => {
  await client.connect(transport);
  return client.getServerVersion?.() ?? null;
}, (d) => (d as { name?: string } | null)?.name === "celld-mcp-runtime");

await check(
  "tools/list",
  async () =>
    (await client.listTools()).tools.map((t: { name: string }) => t.name),
  (d) => (d as string[]).includes("echo") && (d as string[]).includes("build"),
);

await check("tools/call with structured output", async () => {
  const result = await client.callTool({
    name: "add",
    arguments: { a: 2, b: 40 },
  });
  return result.structuredContent;
}, (d) => JSON.stringify(d) === JSON.stringify({ sum: 42 }));

await check(
  "tools/call with an x-mcp-header argument",
  async () => {
    const result = await client.callTool({
      name: "region",
      arguments: { region: "us-east" },
    });
    return result.content;
  },
  (d) =>
    JSON.stringify(d) ===
      JSON.stringify([{ type: "text", text: "in us-east" }]),
);

await check("resources/read", async () => {
  const result = await client.readResource({ uri: "config://app" });
  return result.contents[0]?.text;
}, (d) => d === '{"debug":true}');

await client.close?.();
const failed = checks.filter((c) => !c.ok);
console.log(
  JSON.stringify(
    { sdk: `@modelcontextprotocol/client@${version}`, checks },
    null,
    2,
  ),
);
Deno.exit(failed.length === 0 ? 0 : 1);
