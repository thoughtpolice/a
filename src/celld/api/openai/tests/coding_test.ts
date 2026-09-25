// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { type ToolCall, ToolRegistry } from "@celld/api/openai";
import {
  APPLY_PATCH_GRAMMAR,
  applyPatchTool,
  codingTools,
  execCommandTool,
  globPattern,
  legacyShellTool,
  MemoryFileSystem,
  normalizePath,
  readOnly,
  readOnlyTools,
} from "@celld/api/openai/coding";
import { scriptedShell } from "@celld/api/openai/testing";

function fn(name: string, args: unknown): ToolCall {
  return {
    kind: "function",
    callId: `c-${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

async function run(registry: ToolRegistry, call: ToolCall) {
  const [result] = await registry.execute([call]);
  return result;
}

Deno.test("paths are normalised and kept inside the workspace", () => {
  assertEquals(normalizePath("./a//b/../c"), { ok: true, path: "a/c" });
  assertEquals(normalizePath("."), { ok: true, path: "" });
  for (const bad of ["/etc", "C:\\x", "~/x", "..", "a/../../b", "a\0b"]) {
    assert(!normalizePath(bad).ok, bad);
  }
});

Deno.test("the memory file system has files, implied directories and checks", async () => {
  const fs = new MemoryFileSystem({
    "src/a.ts": "a",
    "src/lib/b.ts": "b",
    "README": "r",
  });
  assertEquals([
    await fs.kind("src"),
    await fs.kind("src/a.ts"),
    await fs.kind("nope"),
    await fs.kind(""),
  ], [
    "dir",
    "file",
    null,
    "dir",
  ]);
  assertEquals(await fs.list("src"), ["src/a.ts", "src/lib/b.ts"]);
  assertEquals(await fs.read("src"), null);
  const errors: string[] = [];
  for (
    const attempt of [
      () => fs.write("src", "x"),
      () => fs.write("README/x", "x"),
      () => fs.remove("src"),
      () => fs.remove("zz"),
    ]
  ) {
    try {
      await attempt();
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  assertEquals(errors, [
    "src is a directory",
    "README is a file, not a directory",
    "src is a directory",
    "no such file: zz",
  ]);
});

Deno.test("readOnly refuses writes", async () => {
  const fs = readOnly(new MemoryFileSystem({ a: "x" }));
  assertEquals(await fs.read("a"), "x");
  let message = "";
  try {
    await fs.write("a", "y");
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "the workspace is read-only: a");
});

Deno.test("apply_patch is Codex's freeform tool with its grammar", async () => {
  const fs = new MemoryFileSystem({ "a.txt": "old\n" });
  const tool = applyPatchTool(fs);
  const registry = new ToolRegistry([tool]);
  const [definition] = registry.definitions();
  assertEquals(definition, {
    type: "custom",
    name: "apply_patch",
    description:
      "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    format: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_GRAMMAR,
    },
  });
  assert(
    APPLY_PATCH_GRAMMAR.startsWith("start: begin_patch hunk+ end_patch\n"),
    "grammar verbatim",
  );
  const ok = await run(registry, {
    kind: "custom",
    callId: "p1",
    name: "apply_patch",
    input:
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n",
  });
  assertEquals([ok.status, ok.output], [
    "ok",
    "Success. Updated the following files:\nM a.txt\n",
  ]);
  const bad = await run(registry, {
    kind: "custom",
    callId: "p2",
    name: "apply_patch",
    input: "nonsense",
  });
  assertEquals(
    bad.output,
    "error: invalid patch: The first line of the patch must be '*** Begin Patch'",
  );
  assertEquals(fs.snapshot(), { "a.txt": "new\n" });
});

Deno.test("read_file numbers lines and pages", async () => {
  const fs = new MemoryFileSystem({ "f.txt": "one\ntwo\nthree\n" });
  const registry = new ToolRegistry(readOnlyTools(fs));
  assertEquals(
    (await run(
      registry,
      fn("read_file", { path: "f.txt", offset: null, limit: null }),
    )).output,
    "1: one\n2: two\n3: three",
  );
  assertEquals(
    (await run(
      registry,
      fn("read_file", { path: "f.txt", offset: 2, limit: 1 }),
    )).output,
    "2: two\n(1 more lines)",
  );
  assertEquals(
    (await run(
      registry,
      fn("read_file", { path: "nope", offset: null, limit: null }),
    )).output,
    "error: no such file: nope",
  );
  assertEquals(
    (await run(
      registry,
      fn("read_file", { path: "f.txt", offset: 9, limit: null }),
    )).output,
    "(f.txt has 3 lines)",
  );
});

Deno.test("list_dir lists files, optionally to a depth", async () => {
  const fs = new MemoryFileSystem({
    "src/a.ts": "",
    "src/deep/b.ts": "",
    "x.md": "",
  });
  const registry = new ToolRegistry(readOnlyTools(fs));
  assertEquals(
    (await run(registry, fn("list_dir", { path: null, depth: null }))).output,
    "src/a.ts\nsrc/deep/b.ts\nx.md",
  );
  assertEquals(
    (await run(registry, fn("list_dir", { path: "src", depth: 1 }))).output,
    "a.ts\ndeep/",
  );
  assertEquals(
    (await run(registry, fn("list_dir", { path: "x.md", depth: null }))).output,
    "error: x.md is a file",
  );
});

Deno.test("grep_files finds lines by pattern and glob", async () => {
  const fs = new MemoryFileSystem({
    "src/a.ts": "const x = eval(input);\nsafe();",
    "src/b.js": "eval('1')",
    "docs/c.md": "eval is bad",
  });
  const registry = new ToolRegistry(readOnlyTools(fs));
  assertEquals(
    (await run(
      registry,
      fn("grep_files", {
        pattern: "eval\\(",
        path: null,
        include: "*.ts",
        limit: null,
      }),
    )).output,
    "src/a.ts:1: const x = eval(input);",
  );
  assertEquals(
    (await run(
      registry,
      fn("grep_files", {
        pattern: "eval",
        path: "src",
        include: null,
        limit: 1,
      }),
    )).output,
    "src/a.ts:1: const x = eval(input);\n(stopped at 1 matches)",
  );
  assertEquals(
    (await run(
      registry,
      fn("grep_files", {
        pattern: "(",
        path: null,
        include: null,
        limit: null,
      }),
    )).status,
    "error",
  );
  assertEquals(
    (await run(
      registry,
      fn("grep_files", {
        pattern: "nothing",
        path: null,
        include: null,
        limit: null,
      }),
    )).output,
    "(no matches)",
  );
});

Deno.test("globs: *, ** and ?", () => {
  assert(globPattern("*.ts").test("src/a.ts"), "*.ts in a subdirectory");
  assert(!globPattern("src/*.ts").test("src/deep/a.ts"), "* stops at /");
  assert(
    globPattern("src/**/*.ts").test("src/deep/er/a.ts"),
    "** crosses directories",
  );
  assert(
    globPattern("a?.md").test("ab.md") && !globPattern("a?.md").test("abc.md"),
    "?",
  );
});

Deno.test("exec_command sends Codex's parameters to the runner and formats the result", async () => {
  const shell = scriptedShell((command, workdir) => ({
    exitCode: 0,
    output: `ran ${command} in ${workdir}`,
  }));
  const registry = new ToolRegistry([execCommandTool(shell)]);
  const [definition] = registry.definitions();
  assert(
    definition.type === "function" && definition.strict === false,
    "non-strict, as Codex declares it",
  );
  assertEquals(definition.parameters.required, ["cmd"]);
  const result = await run(
    registry,
    fn("exec_command", { cmd: "ls -la", workdir: "src" }),
  );
  assert(result.output.startsWith("Exit code: 0\nWall time: "), result.output);
  assert(result.output.endsWith("Output:\nran ls -la in src"), result.output);
  assertEquals(shell.commands, ["ls -la"]);
  const escape = await run(
    registry,
    fn("exec_command", { cmd: "ls", workdir: "../.." }),
  );
  assertEquals(escape.status, "error");
});

Deno.test("exec_command caps output by max_output_tokens", async () => {
  const shell = scriptedShell(() => ({ exitCode: 1, output: "x".repeat(100) }));
  const result = await run(
    new ToolRegistry([execCommandTool(shell)]),
    fn("exec_command", { cmd: "noisy", max_output_tokens: 5 }),
  );
  assert(
    result.output.includes(`${"x".repeat(20)}\n…[output truncated]`),
    result.output,
  );
  assert(result.output.startsWith("Exit code: 1"), result.output);
});

Deno.test("the legacy shell tool takes an argv list", async () => {
  const shell = scriptedShell(() => ({
    exitCode: null,
    output: "",
    timedOut: true,
  }));
  const registry = new ToolRegistry([legacyShellTool(shell)]);
  const result = await run(
    registry,
    fn("shell", { command: ["bash", "-lc", "sleep 99"], timeout_ms: 5 }),
  );
  assert(result.output.startsWith("Process timed out"), result.output);
  assertEquals(shell.commands, [["bash", "-lc", "sleep 99"]]);
  assertEquals(
    (await run(registry, fn("shell", { command: [] }))).output,
    "error: command must not be empty",
  );
});

Deno.test("codingTools composes the usual set", () => {
  const fs = new MemoryFileSystem();
  const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
  assertEquals(names(codingTools({ fs })), [
    "read_file",
    "list_dir",
    "grep_files",
    "apply_patch",
  ]);
  assertEquals(
    names(
      codingTools({
        fs,
        shell: scriptedShell(() => ({ exitCode: 0, output: "" })),
      }),
    ),
    [
      "read_file",
      "list_dir",
      "grep_files",
      "apply_patch",
      "exec_command",
    ],
  );
  assertEquals(names(codingTools({ fs, readOnly: true })), [
    "read_file",
    "list_dir",
    "grep_files",
  ]);
});
