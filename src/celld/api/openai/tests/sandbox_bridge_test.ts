// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/assert";
import { GptClient, ToolRegistry } from "@celld/api/openai";
import { ApplyPatchError } from "@celld/api/openai/coding";
import {
  disassemble,
  PartialPatchError,
  reverseEngineerFile,
  reviewCheckout,
  sandboxApplyPatch,
  sandboxCodingTools,
  sandboxFileSystem,
  sandboxShellRunner,
} from "@celld/api/openai/sandbox";
import {
  FakeResponses,
  type RecordedRequest,
  virtualRuntime,
} from "@celld/api/openai/testing";
import type {
  ExecOptions,
  ExecResult,
  GitCheckoutOptions,
  SandboxApi,
} from "@celld/sandbox";
import { type LocalSandbox, localSandbox } from "@celld/sandbox/testing";

const signal = new AbortController().signal;

async function withSandbox(
  body: (local: LocalSandbox) => Promise<void>,
): Promise<void> {
  const local = await localSandbox();
  try {
    await body(local);
  } finally {
    await local.close();
  }
}

type Box = Pick<
  SandboxApi,
  | "readFile"
  | "writeFile"
  | "deleteFile"
  | "renameFile"
  | "exists"
  | "listFiles"
  | "exec"
  | "execShell"
  | "gitCheckout"
>;

/** The sandbox's methods, bound, with some replaced. */
function boxOf(sandbox: SandboxApi, overrides: Partial<Box> = {}): Box {
  return {
    readFile: sandbox.readFile.bind(sandbox),
    writeFile: sandbox.writeFile.bind(sandbox),
    deleteFile: sandbox.deleteFile.bind(sandbox),
    renameFile: sandbox.renameFile.bind(sandbox),
    exists: sandbox.exists.bind(sandbox),
    listFiles: sandbox.listFiles.bind(sandbox),
    exec: sandbox.exec.bind(sandbox),
    execShell: sandbox.execShell.bind(sandbox),
    gitCheckout: sandbox.gitCheckout.bind(sandbox),
    ...overrides,
  };
}

function client(fake: FakeResponses): GptClient {
  return new GptClient({
    fetch: fake.fetch,
    runtime: virtualRuntime(),
    model: "gpt-5.5",
  });
}

function textOf(request: RecordedRequest): string {
  return request.body.input[0].content[0].text as string;
}

async function modeOf(box: Box, path: string): Promise<string> {
  return (await box.exec(["stat", "-c", "%a", "--", path])).stdout.trim();
}

async function everything(box: Box): Promise<string[]> {
  return await sandboxFileSystem(box).list("");
}

Deno.test("the file system adapter behaves like openai's FileSystem", () =>
  withSandbox(async ({ sandbox }) => {
    const fs = sandboxFileSystem(sandbox);
    assertEquals(await fs.read("missing.txt"), null);
    await fs.write("src/main.ts", "export {};\n");
    await fs.write(".gitignore", "dist\n");
    assertEquals(await fs.read("src/main.ts"), "export {};\n");
    assertEquals(await fs.read("src"), null);
    assertEquals(await fs.kind("src"), "dir");
    assertEquals(await fs.kind("src/main.ts"), "file");
    assertEquals(await fs.kind("nothing"), null);
    assertEquals(await fs.list(""), [".gitignore", "src/main.ts"]);
    assertEquals(await fs.list("src"), ["src/main.ts"]);
    assertEquals(await fs.list("absent"), []);
    await fs.remove("src/main.ts");
    assertEquals(await fs.read("src/main.ts"), null);
    await sandbox.writeFile("binary", new Uint8Array([0xff, 0xfe]));
    assertEquals(await fs.read("binary"), null);
    const escape = await assertRejects(fs.read("../escape"));
    assert(escape instanceof Error, "paths outside the workspace still throw");
  }));

Deno.test("the shell adapter runs lines and argv with combined output", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    const shell = sandboxShellRunner(sandbox);
    await sandbox.mkdir("pkg");
    const line = await shell.run({
      command: "pwd; echo err >&2; exit 3",
      workdir: "pkg",
      timeoutMs: 5_000,
      signal,
    });
    assertEquals(line.exitCode, 3);
    assert(
      line.output.includes(`${workspace}/pkg`) && line.output.includes("err"),
      line.output,
    );
    const argv = await shell.run({
      command: ["echo", "$HOME"],
      workdir: null,
      timeoutMs: 5_000,
      signal,
    });
    assertEquals(argv.output, "$HOME\n");
    const slow = await shell.run({
      command: "sleep 10",
      workdir: null,
      timeoutMs: 200,
      signal,
    });
    assertEquals([slow.exitCode, slow.timedOut], [null, true]);
    const cut = await sandboxShellRunner(sandbox, { maxOutputBytes: 10 }).run({
      command: "echo 0123456789abcdef",
      workdir: null,
      timeoutMs: 5_000,
      signal,
    });
    assertEquals(cut.output, "0123456789\n…[output truncated]");
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    const refused = await assertRejects(shell.run({
      command: "true",
      workdir: null,
      timeoutMs: 1_000,
      signal: aborted.signal,
    }));
    assertEquals(refused.message, "stop");
  }));

const PATCH = [
  "*** Begin Patch",
  "*** Add File: src/lib/new.ts",
  "+export const added = true;",
  "*** Update File: run.sh",
  "@@",
  "-echo old",
  "+echo new",
  "*** Update File: notes/a.txt",
  "*** Move to: notes/b.txt",
  "@@",
  " keep",
  "-drop",
  "+moved",
  "*** Delete File: gone.txt",
  "*** End Patch",
  "",
].join("\n");

async function seed(box: Box): Promise<void> {
  await box.writeFile("run.sh", "#!/bin/sh\necho old\n", { mode: "755" });
  await box.writeFile("notes/a.txt", "keep\ndrop\n");
  await box.writeFile("gone.txt", "bye\n");
}

Deno.test("apply_patch over the sandbox stages, renames and keeps modes", () =>
  withSandbox(async ({ sandbox }) => {
    const box = boxOf(sandbox);
    await seed(box);
    const applied = await sandboxApplyPatch(box, PATCH);
    assertEquals(
      applied.summary,
      [
        "Success. Updated the following files:",
        "A src/lib/new.ts",
        "M run.sh",
        "M notes/b.txt",
        "D gone.txt",
        "",
      ].join("\n"),
    );
    const fs = sandboxFileSystem(box);
    assertEquals(await everything(box), [
      "notes/b.txt",
      "run.sh",
      "src/lib/new.ts",
    ]);
    assertEquals(await fs.read("run.sh"), "#!/bin/sh\necho new\n");
    assertEquals(await fs.read("notes/b.txt"), "keep\nmoved\n");
    assertEquals(
      await fs.read("src/lib/new.ts"),
      "export const added = true;\n",
    );
    assertEquals(await modeOf(box, "run.sh"), "755");
    assertEquals((await box.exec(["./run.sh"])).stdout, "new\n");
  }));

Deno.test("a patch that does not fit changes nothing", () =>
  withSandbox(async ({ sandbox }) => {
    const box = boxOf(sandbox);
    await seed(box);
    const error = await assertRejects(sandboxApplyPatch(
      box,
      PATCH.replace("-echo old", "-echo older"),
    ));
    assert(error instanceof ApplyPatchError, String(error));
    assertEquals((error as ApplyPatchError).kind, "apply");
    assertEquals(await everything(box), ["gone.txt", "notes/a.txt", "run.sh"]);
    assertEquals(
      await sandboxFileSystem(box).read("run.sh"),
      "#!/bin/sh\necho old\n",
    );
  }));

Deno.test("a failed rename reports what was and was not applied", () =>
  withSandbox(async ({ sandbox }) => {
    let renames = 0;
    const box = boxOf(sandbox, {
      async renameFile(from, to) {
        if (++renames === 2) throw new Error("disk on fire");
        await sandbox.renameFile(from, to);
      },
    });
    await seed(box);
    const error = await assertRejects(sandboxApplyPatch(box, PATCH));
    assert(error instanceof PartialPatchError, String(error));
    const partial = error as PartialPatchError;
    assertEquals(partial.committed, ["src/lib/new.ts"]);
    assertEquals(partial.pending, [
      "run.sh",
      "notes/b.txt",
      "notes/a.txt",
      "gone.txt",
    ]);
    assert(partial.message.includes("disk on fire"), partial.message);
    // No temporary files are left behind.
    assertEquals(await everything(box), [
      "gone.txt",
      "notes/a.txt",
      "run.sh",
      "src/lib/new.ts",
    ]);
  }));

Deno.test("the coding tools over a sandbox use the staged apply_patch", () =>
  withSandbox(async ({ sandbox }) => {
    const box = boxOf(sandbox);
    await seed(box);
    const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
    assertEquals(names(sandboxCodingTools(box, { readOnly: true })), [
      "read_file",
      "list_dir",
      "grep_files",
    ]);
    assertEquals(names(sandboxCodingTools(box, { shell: false })), [
      "read_file",
      "list_dir",
      "grep_files",
      "apply_patch",
    ]);
    const registry = new ToolRegistry(sandboxCodingTools(box));
    const [patched, ran] = await registry.execute([
      { kind: "custom", callId: "p", name: "apply_patch", input: PATCH },
    ]).then(async (first) => [
      ...first,
      ...(await registry.execute([{
        kind: "function",
        callId: "x",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "./run.sh" }),
      }])),
    ]);
    assertEquals(patched.status, "ok");
    assert(patched.output.includes("M run.sh"), patched.output);
    assert(ran.output.includes("Exit code: 0"), ran.output);
    assert(ran.output.endsWith("Output:\nnew\n"), ran.output);
  }));

const OBJDUMP = `#!/bin/sh
# A stand-in objdump: prints two functions, or fails for "bad".
case "$*" in *bad*) echo "not an object file" >&2; exit 1;; esac
echo "0000000000401136 <main>:"
echo "  call 401150 <helper>"
echo "0000000000401150 <helper>:"
echo "  ret"
`;

/** Runs `bin/<tool>` from the workspace in place of the real tool. */
function withFakeTools(
  sandbox: SandboxApi,
  calls: { argv: string[]; options?: ExecOptions }[],
): Box {
  return boxOf(sandbox, {
    exec(argv, options) {
      calls.push({ argv, ...(options === undefined ? {} : { options }) });
      return sandbox.exec(["sh", `bin/${argv[0]}`, ...argv.slice(1)], options);
    },
  });
}

Deno.test("disassemble runs the analyzer with argv, a deadline and a cap", () =>
  withSandbox(async ({ sandbox }) => {
    const calls: { argv: string[]; options?: ExecOptions }[] = [];
    const box = withFakeTools(sandbox, calls);
    await box.writeFile("bin/objdump", OBJDUMP);
    await box.writeFile("bin/strings", "#!/bin/sh\necho evil.example\n");
    await box.writeFile("upload/a.out", "\x7fELF");
    const listing = await disassemble(box, "./upload/a.out");
    assertEquals(listing.argv, [
      "objdump",
      "-d",
      "-C",
      "--no-show-raw-insn",
      "--",
      "upload/a.out",
    ]);
    assertEquals(calls[0].options, {
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    });
    assert(listing.text.startsWith("0000000000401136 <main>:\n"), listing.text);
    assertEquals(listing.truncated, false);
    const strings = await disassemble(box, "upload/a.out", {
      tool: "strings",
      timeoutMs: 5_000,
      maxOutputBytes: 4,
    });
    assertEquals(strings.argv, [
      "strings",
      "-a",
      "-n",
      "6",
      "--",
      "upload/a.out",
    ]);
    assertEquals([strings.text, strings.truncated], ["evil", true]);
    const custom = await disassemble(box, "upload/a.out", {
      tool: "strings",
      args: ["-n", "10"],
    });
    assertEquals(custom.argv, ["strings", "-n", "10", "--", "upload/a.out"]);
    const failed = await assertRejects(disassemble(box, "upload/bad"));
    assertEquals(
      failed.message,
      "objdump failed with exit code 1: not an object file",
    );
    const escape = await assertRejects(disassemble(box, "../../etc/passwd"));
    assert(escape.message.includes("leaves the workspace"), escape.message);
    const unknown = await assertRejects(
      // deno-lint-ignore no-explicit-any
      disassemble(box, "upload/a.out", { tool: "gdb" as any }),
    );
    assertEquals(unknown.message, "unknown analyzer: gdb");
    assertEquals(calls.length, 4);
  }));

Deno.test("reverseEngineerFile feeds the disassembly to reverseEngineer", () =>
  withSandbox(async ({ sandbox }) => {
    const box = withFakeTools(sandbox, []);
    await box.writeFile("bin/objdump", OBJDUMP);
    await box.writeFile("upload/a.out", "\x7fELF");
    const fake = new FakeResponses([{
      text: JSON.stringify({
        summary: "main calls helper",
        architecture: "x86-64 SysV",
        functions: [
          { name: "main", purpose: "entry", confidence: 0.9 },
          { name: "helper", purpose: "returns", confidence: 0.7 },
        ],
        capabilities: [],
        indicators: [],
        vulnerabilities: [],
        openQuestions: [],
      }),
    }]);
    const { result, disassembly, chunks } = await reverseEngineerFile(
      client(fake),
      box,
      "upload/a.out",
      { effort: "medium" },
    );
    assertEquals(chunks, 1);
    assertEquals(disassembly.tool, "objdump");
    assertEquals(result.functions.map((f) => f.name), ["main", "helper"]);
    const body = fake.requests[0].body;
    assertEquals([body.text.format.name, body.reasoning.effort], [
      "re_notes",
      "medium",
    ]);
    const input = body.input[0].content[0].text as string;
    assert(
      input.startsWith(
        "Context: objdump output for upload/a.out\n<disassembly>\n0000000000401136 <main>:",
      ),
      input,
    );
  }));

const REVIEW = {
  summary: "Builds SQL from user input.",
  findings: [{
    title: "SQL injection in lookup",
    severity: "high",
    cwe: "CWE-89",
    location: { path: "src/app.py", startLine: 2, endLine: 2, symbol: "find" },
    evidence: "f-string query",
    exploitability: "any caller",
    confidence: 0.9,
    remediation: "parameterise",
  }],
};

Deno.test("reviewCheckout clones, reads the checkout read-only and reviews it", () =>
  withSandbox(async ({ sandbox }) => {
    const clones: { url: string; options?: GitCheckoutOptions }[] = [];
    const box = boxOf(sandbox, {
      async gitCheckout(url, options): Promise<ExecResult> {
        clones.push({ url, ...(options === undefined ? {} : { options }) });
        const dir = options?.targetDir ?? "api";
        await sandbox.writeFile(`${dir}/.git/config`, "[core]\n");
        await sandbox.writeFile(
          `${dir}/src/app.py`,
          "def find(db, name):\n    return db.execute(f\"... '{name}'\")\n",
        );
        await sandbox.writeFile(`${dir}/README.md`, "# api\n");
        await sandbox.writeFile(`${dir}/big.sql`, "x".repeat(100));
        await sandbox.writeFile(
          `${dir}/logo.png`,
          new Uint8Array([0x89, 0xff]),
        );
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    });
    // One chunk per file; only src/app.py has a finding.
    const answer = (request: RecordedRequest) => ({
      text: JSON.stringify(
        textOf(request).includes("// file: src/app.py")
          ? REVIEW
          : { summary: "docs", findings: [] },
      ),
    });
    const fake = new FakeResponses([answer, answer]);
    const review = await reviewCheckout(
      client(fake),
      box,
      "https://git.example/acme/api.git",
      { branch: "main", maxFileChars: 80, context: "a user service" },
    );
    assertEquals(clones, [{
      url: "https://git.example/acme/api.git",
      options: { branch: "main" },
    }]);
    assertEquals(review.directory, "api");
    assertEquals(review.files, ["README.md", "src/app.py"]);
    assertEquals(review.skipped, ["big.sql"]);
    assertEquals(review.findings.map((f) => f.cwe), ["CWE-89"]);
    assertEquals(fake.requests.length, 2);
    const text = fake.requests.map(textOf).find((input) =>
      input.includes("src/app.py")
    )!;
    assert(text.startsWith("Context: a user service\n"), text);
    assert(text.includes("// file: src/app.py\n1: def find"), text);
    assert(!text.includes("[core]"), "the .git directory is skipped");
    assertEquals(await review.fs.read("README.md"), "# api\n");
    assertEquals(await review.fs.list("src"), ["src/app.py"]);
    const write = await assertRejects(review.fs.write("README.md", "x"));
    assert(write.message.includes("read-only"), write.message);

    const only = new FakeResponses([{ text: JSON.stringify(REVIEW) }]);
    const filtered = await reviewCheckout(
      client(only),
      box,
      "https://git.example/acme/api",
      { targetDir: "second", include: ["src/**"] },
    );
    assertEquals([filtered.directory, filtered.files], ["second", [
      "src/app.py",
    ]]);
  }));

Deno.test("reviewCheckout reports a failed clone and an empty checkout", () =>
  withSandbox(async ({ sandbox }) => {
    const failing = boxOf(sandbox, {
      gitCheckout: () =>
        Promise.resolve({
          success: false,
          exitCode: 128,
          stdout: "",
          stderr: "fatal: repository not found\n",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        }),
    });
    const fake = new FakeResponses();
    const failed = await assertRejects(
      reviewCheckout(client(fake), failing, "https://git.example/acme/nope"),
    );
    assertEquals(
      failed.message,
      "git clone of https://git.example/acme/nope failed with exit code 128: fatal: repository not found",
    );
    const empty = boxOf(sandbox, {
      async gitCheckout() {
        await sandbox.writeFile("empty/.git/HEAD", "ref: main\n");
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    });
    const nothing = await assertRejects(
      reviewCheckout(client(fake), empty, "https://git.example/acme/empty"),
    );
    assertEquals(nothing.message, "nothing to review in empty");
    assertEquals(fake.requests.length, 0);
  }));
