// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  frontmatter,
  resourceLinks,
  validateFile,
  validateMetadata,
} from "../tools/omp-validate.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("native agents reject reserved names and preserve restricted tools", () => {
  const good = validateMetadata("agent", {
    name: "Reviewer",
    description: "Review API changes",
    tools: [],
    spawns: [],
    "read-summarize": false,
  }, "Report evidence-backed findings.");
  assert(good.valid, "Empty tool/spawn lists are valid native restrictions");
  for (const name of ["main", " SUB "]) {
    assert(
      !validateMetadata("agent", { name, description: "Review" }, "Work").valid,
      "Reserved sentinels cannot be shadowed",
    );
  }
  const malformed = validateMetadata("agent", {
    name: "reviewer",
    description: "Review",
    tools: [42],
    blocking: "true",
  }, "Work");
  assert(
    !malformed.valid &&
      malformed.diagnostics.some((d) => d.field === "tools") &&
      malformed.diagnostics.some((d) => d.field === "blocking"),
    "Dropped native semantics must be reported",
  );
});

Deno.test("skills require native description and do not invent triggers", () => {
  assert(
    !validateMetadata("skill", { name: "nested/name", description: "" }, "Work")
      .valid,
    "Namespaced raw name and empty native description are invalid",
  );
  const metadata = validateMetadata("skill", {
    description: "Use to inspect records",
    globs: ["*.ts"],
    alwaysApply: true,
  }, "Inspect records");
  assert(
    metadata.valid &&
      metadata.diagnostics.some((d) => d.severity === "warning"),
    "Invocation metadata is advisory, not invalid or automatic",
  );
});

Deno.test("native rule scopes and Hookify fields have distinct semantics", () => {
  assert(
    validateMetadata("rule", {
      condition: "danger",
      scope: ["text", "tool:edit(*.ts)"],
      interruptMode: "tool-only",
    }, "Use safe operations").valid,
    "Native scopes accepted",
  );
  assert(
    !validateMetadata("rule", {
      condition: "danger",
      scope: "bash",
      interruptMode: "block",
    }, "Safe").valid,
    "Unknown stream and interruption mode rejected",
  );
  assert(
    !validateMetadata("rule", {
      event: "file",
      action: "block",
      pattern: "danger",
    }, "Safe").valid,
    "Claude Hookify rule must not pretend to be enforceable OMP rule",
  );
  const hidden = validateMetadata("rule", {}, "Unaddressable guidance");
  assert(
    hidden.valid && hidden.diagnostics.some((d) => d.field === "description"),
    "No-bucket rule warns instead of claiming runtime exposure",
  );
});

Deno.test("MCP validates inferred transports, conflicts, credential shape and timeout boundaries", () => {
  const good = validateMetadata("mcp", {
    mcpServers: {
      local: { command: "bun", args: [], timeout: 0 },
      remote: {
        url: "https://example.invalid/mcp",
        instructions: false,
        requestIdFormat: "string",
        oauth: { callbackPort: 3334 },
      },
    },
  });
  assert(good.valid, "Native transport inference and zero timeout accepted");
  for (
    const server of [
      { command: "bun", url: "https://example.invalid" },
      { type: "ws", url: "wss://example.invalid" },
      { type: "http" },
      { command: "bun", env: { SECRET: 42 } },
      { command: "bun", timeout: -1 },
      { url: "https://example.invalid", oauth: { callbackPort: 65536 } },
    ]
  ) {
    assert(
      !validateMetadata("mcp", { mcpServers: { selected: server } }).valid,
      "Invalid transport/config semantics rejected",
    );
  }
});

Deno.test("diagnostic cap never turns suppressed errors into success", () => {
  const checked = validateMetadata(
    "agent",
    { name: "sub", tools: [42], blocking: "yes" },
    "",
    1,
  );
  assert(
    !checked.valid && checked.truncated && checked.diagnostics.length === 1,
    "Bounded report retains invalid status",
  );
});

Deno.test("MCP file validation is strict JSON, confined, read-only and secret-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-validation-"));
  try {
    await writeFile(
      join(root, "good.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.invalid",
            headers: { Authorization: "!never-execute" },
          },
        },
      }),
    );
    await writeFile(join(root, "bad.json"), '{"mcpServers":{},}');
    await writeFile(
      join(root, "invalid-utf8.json"),
      new Uint8Array([
        ...new TextEncoder().encode('{"mcpServers":{"demo":{"command":"'),
        255,
        ...new TextEncoder().encode('"}}}'),
      ]),
    );
    await symlink(join(root, "good.json"), join(root, "link.json"));
    assert(
      (await validateFile(root, { kind: "mcp", path: "good.json" })).valid,
      "Config strings are validated without resolving shell secrets or connecting",
    );
    assert(
      !(await validateFile(root, { kind: "mcp", path: "bad.json" })).valid,
      "Trailing comma is not strict JSON",
    );
    assert(
      !(await validateFile(root, { kind: "mcp", path: "invalid-utf8.json" }))
        .valid,
      "Invalid UTF-8 must not silently change a configured command",
    );
    assert(
      !(await validateFile(root, { kind: "mcp", path: "../outside.json" }))
        .valid,
      "Workspace escape rejected",
    );
    assert(
      !(await validateFile(root, { kind: "mcp", path: "link.json" })).valid,
      "Symlink input rejected",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("frontmatter delimiters fail explicitly rather than field regex fallback", () => {
  for (const text of ["name: test\nWork", "---\nname: test\nWork"]) {
    let failed = false;
    try {
      frontmatter(text, true);
    } catch {
      failed = true;
    }
    assert(failed, "Missing/unterminated frontmatter rejected");
  }
});

Deno.test("resource validation distinguishes links from fenced and inline code examples", () => {
  const body = [
    "[guide](guide.md)",
    "```md",
    "[example](missing.md)",
    "````",
    "",
    "~~~markdown",
    "[definition]: nonexistent.md",
    "~~~",
    "",
    "`[literal](inline-missing.md)` ![diagram](diagram.svg)",
    "`` [literal ` tick](other-missing.md) `` [notes]: not-a-definition",
    "[notes]: notes.md",
    "unmatched ` [real](real.md)",
  ].join("\n");
  assert(
    JSON.stringify(resourceLinks(body)) ===
      JSON.stringify(["guide.md", "diagram.svg", "real.md", "notes.md"]),
    "Only actual resource links and definitions should require files",
  );
});
